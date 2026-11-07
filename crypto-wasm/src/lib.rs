//! The only cryptographic entry point for the web client: an OpenMLS wrapper compiled to WASM.
//!
//! One ciphersuite is accepted everywhere. The RustCrypto provider links NIST-curve code that
//! this product must never use (accepted risk RUSTSEC-2026-0387), so every key package and
//! welcome is checked against the shipped suite before anything else happens to it.

pub mod padding;
pub mod wasm;

use openmls::group::PURE_CIPHERTEXT_WIRE_FORMAT_POLICY;
use openmls::group::{MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::{
    BasicCredential, Ciphersuite, CredentialWithKey, KeyPackage, KeyPackageIn, LeafNodeIndex,
    MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, ProcessedMessageContent, ProtocolMessage,
    ProtocolVersion,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::collections::HashMap;
use wasm_bindgen::prelude::wasm_bindgen;

/// The one MLS ciphersuite used by every Conversation (X25519, ChaCha20-Poly1305, Ed25519).
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// The ciphersuite's registry number, for tests and for clients to compare.
pub const CIPHERSUITE_ID: u16 = 0x0003;

/// Reports the ciphersuite so the client can refuse an incompatible module.
#[wasm_bindgen]
pub fn ciphersuite_id() -> u16 {
    u16::from(CIPHERSUITE)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// The bytes are not a valid MLS object of the expected kind.
    Malformed,
    /// A key package or welcome uses a ciphersuite other than the shipped one.
    UnsupportedCiphersuite,
    UnknownGroup,
    /// MLS refused the operation (not a member, replay, bad signature, wrong epoch, ...).
    Rejected,
    TooLarge,
}

impl Error {
    /// A stable name for the error, the only error detail that crosses into JavaScript.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnsupportedCiphersuite => "unsupported_ciphersuite",
            Self::UnknownGroup => "unknown_group",
            Self::Rejected => "rejected",
            Self::TooLarge => "too_large",
        }
    }
}

/// What a received group message turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    /// An application message, with padding removed.
    Message(Vec<u8>),
    /// A membership change by someone else; the group state has advanced.
    GroupChanged,
    /// This client was removed; its copy of the group is no longer usable.
    Removed,
}

pub struct Member {
    pub index: u32,
    pub identity: Vec<u8>,
}

/// The result of adding a member: `commit` goes to the existing members, `welcome` to the new one.
pub struct Added {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// One Device's MLS state: its identity and every group it belongs to.
pub struct Client {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    groups: HashMap<Vec<u8>, MlsGroup>,
}

fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .use_ratchet_tree_extension(true)
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .use_ratchet_tree_extension(true)
        .build()
}

fn encode(message: &MlsMessageOut) -> Result<Vec<u8>, Error> {
    message
        .tls_serialize_detached()
        .map_err(|_| Error::Rejected)
}

/// Parses a serialized message and requires the whole input to be used.
fn parse(bytes: &[u8]) -> Result<MlsMessageBodyIn, Error> {
    let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| Error::Malformed)?;
    Ok(message.extract())
}

/// Only encrypted group messages are accepted: a plaintext handshake would expose membership.
fn protocol_message(bytes: &[u8]) -> Result<ProtocolMessage, Error> {
    match parse(bytes)? {
        MlsMessageBodyIn::PrivateMessage(message) => Ok(message.into()),
        _ => Err(Error::Malformed),
    }
}

impl Client {
    /// Creates a Device identity. `identity` is the public name other members see.
    pub fn new(identity: &[u8]) -> Result<Self, Error> {
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|_| Error::Rejected)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Ok(Self {
            provider: OpenMlsRustCrypto::default(),
            signer,
            credential,
            groups: HashMap::new(),
        })
    }

    /// A fresh single-use key package, to be published so others can add this Device.
    pub fn key_package(&self) -> Result<Vec<u8>, Error> {
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(|_| Error::Rejected)?;
        encode(&MlsMessageOut::from(bundle.key_package().clone()))
    }

    /// Starts a group with only this Device in it; returns the group id.
    pub fn create_group(&mut self) -> Result<Vec<u8>, Error> {
        let group = MlsGroup::new(
            &self.provider,
            &self.signer,
            &create_config(),
            self.credential.clone(),
        )
        .map_err(|_| Error::Rejected)?;
        let id = group.group_id().as_slice().to_vec();
        self.groups.insert(id.clone(), group);
        Ok(id)
    }

    /// Adds the owner of `key_package` and applies the change here at once.
    pub fn add_member(&mut self, group: &[u8], key_package: &[u8]) -> Result<Added, Error> {
        let key_package = self.checked_key_package(key_package)?;
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group).ok_or(Error::UnknownGroup)?;
        let (commit, welcome, _) = group
            .add_members(provider, signer, &[key_package])
            .map_err(|_| Error::Rejected)?;
        group
            .merge_pending_commit(provider)
            .map_err(|_| Error::Rejected)?;
        Ok(Added {
            commit: encode(&commit)?,
            welcome: encode(&welcome)?,
        })
    }

    /// Parses a key package, checks its signatures and then its ciphersuite.
    fn checked_key_package(&self, bytes: &[u8]) -> Result<KeyPackage, Error> {
        let MlsMessageBodyIn::KeyPackage(key_package) = parse(bytes)? else {
            return Err(Error::Malformed);
        };
        let key_package = validate(key_package, &self.provider)?;
        if key_package.ciphersuite() != CIPHERSUITE {
            return Err(Error::UnsupportedCiphersuite);
        }
        Ok(key_package)
    }

    /// Joins the group a welcome message is for; returns the group id.
    pub fn join(&mut self, welcome: &[u8]) -> Result<Vec<u8>, Error> {
        let MlsMessageBodyIn::Welcome(welcome) = parse(welcome)? else {
            return Err(Error::Malformed);
        };
        if welcome.ciphersuite() != CIPHERSUITE {
            return Err(Error::UnsupportedCiphersuite);
        }
        let group = StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome, None)
            .and_then(|staged| staged.into_group(&self.provider))
            .map_err(|_| Error::Rejected)?;
        let id = group.group_id().as_slice().to_vec();
        self.groups.insert(id.clone(), group);
        Ok(id)
    }

    pub fn members(&self, group: &[u8]) -> Result<Vec<Member>, Error> {
        let group = self.groups.get(group).ok_or(Error::UnknownGroup)?;
        Ok(group
            .members()
            .map(|member| Member {
                index: member.index.u32(),
                identity: BasicCredential::try_from(member.credential)
                    .map(|credential| credential.identity().to_vec())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// Removes the member at `index` and applies the change here at once; returns the commit.
    pub fn remove_member(&mut self, group: &[u8], index: u32) -> Result<Vec<u8>, Error> {
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group).ok_or(Error::UnknownGroup)?;
        let (commit, _, _) = group
            .remove_members(provider, signer, &[LeafNodeIndex::new(index)])
            .map_err(|_| Error::Rejected)?;
        group
            .merge_pending_commit(provider)
            .map_err(|_| Error::Rejected)?;
        encode(&commit)
    }

    /// Pads and encrypts one application message.
    pub fn encrypt(&mut self, group: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        let padded = padding::pad(plaintext).map_err(|_| Error::TooLarge)?;
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group).ok_or(Error::UnknownGroup)?;
        let message = group
            .create_message(provider, signer, &padded)
            .map_err(|_| Error::Rejected)?;
        encode(&message)
    }

    /// Processes a message from the group: decrypts it, or applies a membership change.
    pub fn receive(&mut self, group: &[u8], bytes: &[u8]) -> Result<Received, Error> {
        let provider = &self.provider;
        let state = self.groups.get_mut(group).ok_or(Error::UnknownGroup)?;
        let message = protocol_message(bytes)?;
        let processed = state
            .process_message(provider, message)
            .map_err(|_| Error::Rejected)?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                let text =
                    padding::unpad(&application.into_bytes()).map_err(|_| Error::Rejected)?;
                Ok(Received::Message(text))
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                let removed = staged.self_removed();
                state
                    .merge_staged_commit(provider, *staged)
                    .map_err(|_| Error::Rejected)?;
                Ok(if removed {
                    Received::Removed
                } else {
                    Received::GroupChanged
                })
            }
            _ => Err(Error::Rejected),
        }
    }
}

fn validate(key_package: KeyPackageIn, provider: &OpenMlsRustCrypto) -> Result<KeyPackage, Error> {
    use openmls_traits::OpenMlsProvider as _;
    key_package
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|_| Error::Rejected)
}
