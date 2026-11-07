//! Saving and restoring one Device's MLS state. The bytes hold secret keys and group secrets, so
//! the caller must seal them (the web vault does) before they touch storage. The format is
//! private to this crate: a version byte, then length-prefixed fields.

use crate::{CIPHERSUITE, Client, Error};
use openmls::group::{GroupId, MlsGroup};
use openmls::prelude::{BasicCredential, CredentialWithKey};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider as _;
use std::collections::HashMap;

const VERSION: u8 = 1;

fn put(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Error> {
    let length = u32::try_from(bytes.len()).map_err(|_| Error::TooLarge)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn put_count(out: &mut Vec<u8>, count: usize) -> Result<(), Error> {
    let count = u32::try_from(count).map_err(|_| Error::TooLarge)?;
    out.extend_from_slice(&count.to_be_bytes());
    Ok(())
}

/// Reads length-prefixed fields and fails on anything short.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Error> {
        let (head, rest) = self.0.split_at_checked(count).ok_or(Error::Malformed)?;
        self.0 = rest;
        Ok(head)
    }

    fn count(&mut self) -> Result<usize, Error> {
        let bytes: [u8; 4] = self.take(4)?.try_into().map_err(|_| Error::Malformed)?;
        usize::try_from(u32::from_be_bytes(bytes)).map_err(|_| Error::Malformed)
    }

    fn field(&mut self) -> Result<&'a [u8], Error> {
        let length = self.count()?;
        self.take(length)
    }
}

impl Client {
    /// Everything needed to continue as this Device later: keys, credential, groups and secrets.
    pub fn export_state(&self) -> Result<Vec<u8>, Error> {
        let credential = BasicCredential::try_from(self.credential.credential.clone())
            .map_err(|_| Error::Rejected)?;
        let mut out = vec![VERSION];
        put(&mut out, credential.identity())?;
        put(&mut out, self.signer.public())?;
        put_count(&mut out, self.groups.len())?;
        for id in self.groups.keys() {
            put(&mut out, id)?;
        }
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| Error::Rejected)?;
        put_count(&mut out, values.len())?;
        for (key, value) in values.iter() {
            put(&mut out, key)?;
            put(&mut out, value)?;
        }
        Ok(out)
    }

    /// Rebuilds a Device from `export_state` output; anything else is `Malformed`.
    pub fn restore(state: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader(state);
        if reader.take(1)? != [VERSION] {
            return Err(Error::Malformed);
        }
        let identity = reader.field()?;
        let public = reader.field()?.to_vec();
        let ids = (0..reader.count()?)
            .map(|_| reader.field())
            .collect::<Result<Vec<_>, _>>()?;
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| Error::Rejected)?;
            for _ in 0..reader.count()? {
                values.insert(reader.field()?.to_vec(), reader.field()?.to_vec());
            }
        }
        if !reader.0.is_empty() {
            return Err(Error::Malformed);
        }
        // The signing key is among the stored values: `Client::new` saves it there.
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &public,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or(Error::Malformed)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        let groups = load_groups(&provider, &ids)?;
        Ok(Self {
            provider,
            signer,
            credential,
            groups,
        })
    }
}

fn load_groups(
    provider: &OpenMlsRustCrypto,
    ids: &[&[u8]],
) -> Result<HashMap<Vec<u8>, MlsGroup>, Error> {
    ids.iter()
        .map(|id| {
            let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(id))
                .map_err(|_| Error::Malformed)?
                .ok_or(Error::Malformed)?;
            Ok((id.to_vec(), group))
        })
        .collect()
}
