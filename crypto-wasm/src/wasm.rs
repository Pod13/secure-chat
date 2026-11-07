//! The surface exposed to JavaScript. It only moves bytes: all rules live in `Client`.
//! Errors cross the boundary as a short code string and nothing else.

use crate::{Added, Client, Received, Route};
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

pub const KIND_MESSAGE: u8 = 0;
pub const KIND_GROUP_CHANGED: u8 = 1;
pub const KIND_REMOVED: u8 = 2;

fn code(error: crate::Error) -> String {
    error.code().to_string()
}

#[wasm_bindgen]
pub struct WasmAdded(Added);

#[wasm_bindgen]
impl WasmAdded {
    pub fn commit(&self) -> Vec<u8> {
        self.0.commit.clone()
    }
    pub fn welcome(&self) -> Vec<u8> {
        self.0.welcome.clone()
    }
}

#[wasm_bindgen]
pub struct WasmRoute(Route);

#[wasm_bindgen]
impl WasmRoute {
    pub fn is_welcome(&self) -> bool {
        self.0 == Route::Welcome
    }
    /// The group id for a group message; empty for a Welcome.
    pub fn group(&self) -> Vec<u8> {
        match &self.0 {
            Route::Group(id) => id.clone(),
            Route::Welcome => Vec::new(),
        }
    }
}

#[wasm_bindgen]
pub struct WasmReceived(Received);

#[wasm_bindgen]
impl WasmReceived {
    pub fn kind(&self) -> u8 {
        match self.0 {
            Received::Message(_) => KIND_MESSAGE,
            Received::GroupChanged => KIND_GROUP_CHANGED,
            Received::Removed => KIND_REMOVED,
        }
    }
    /// The message text for `KIND_MESSAGE`, empty otherwise.
    pub fn message(&self) -> Vec<u8> {
        match &self.0 {
            Received::Message(text) => text.clone(),
            _ => Vec::new(),
        }
    }
}

#[wasm_bindgen]
pub struct WasmClient(RefCell<Client>);

#[wasm_bindgen]
impl WasmClient {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8]) -> Result<WasmClient, String> {
        Client::new(identity)
            .map(|c| Self(RefCell::new(c)))
            .map_err(code)
    }
    /// Classifies an incoming envelope before it is decrypted.
    pub fn route(bytes: &[u8]) -> Result<WasmRoute, String> {
        Client::route(bytes).map(WasmRoute).map_err(code)
    }
    /// Rebuilds a Device from bytes made by `export_state`.
    pub fn restore(state: &[u8]) -> Result<WasmClient, String> {
        Client::restore(state)
            .map(|c| Self(RefCell::new(c)))
            .map_err(code)
    }
    /// The Device's secret state. The caller must seal it before storing it.
    pub fn export_state(&self) -> Result<Vec<u8>, String> {
        self.0.borrow().export_state().map_err(code)
    }
    pub fn key_package(&self) -> Result<Vec<u8>, String> {
        self.0.borrow().key_package().map_err(code)
    }
    pub fn last_resort_key_package(&self) -> Result<Vec<u8>, String> {
        self.0.borrow().last_resort_key_package().map_err(code)
    }
    pub fn create_group(&self) -> Result<Vec<u8>, String> {
        self.0.borrow_mut().create_group().map_err(code)
    }
    pub fn add_member(&self, group: &[u8], key_package: &[u8]) -> Result<WasmAdded, String> {
        let added = self.0.borrow_mut().add_member(group, key_package);
        added.map(WasmAdded).map_err(code)
    }
    pub fn join(&self, welcome: &[u8]) -> Result<Vec<u8>, String> {
        self.0.borrow_mut().join(welcome).map_err(code)
    }
    pub fn remove_member(&self, group: &[u8], index: u32) -> Result<Vec<u8>, String> {
        self.0
            .borrow_mut()
            .remove_member(group, index)
            .map_err(code)
    }
    pub fn encrypt(&self, group: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
        self.0.borrow_mut().encrypt(group, plaintext).map_err(code)
    }
    pub fn receive(&self, group: &[u8], bytes: &[u8]) -> Result<WasmReceived, String> {
        let received = self.0.borrow_mut().receive(group, bytes);
        received.map(WasmReceived).map_err(code)
    }
    pub fn member_count(&self, group: &[u8]) -> Result<u32, String> {
        let members = self.0.borrow().members(group).map_err(code)?;
        u32::try_from(members.len()).map_err(|_| "rejected".to_string())
    }
    /// The leaf index of the `position`-th member, for use with `remove_member`.
    pub fn member_index(&self, group: &[u8], position: u32) -> Result<u32, String> {
        let members = self.0.borrow().members(group).map_err(code)?;
        let at = usize::try_from(position).map_err(|_| "rejected".to_string())?;
        members
            .get(at)
            .map(|m| m.index)
            .ok_or_else(|| "rejected".to_string())
    }
    pub fn member_identity(&self, group: &[u8], index: u32) -> Result<Vec<u8>, String> {
        let members = self.0.borrow().members(group).map_err(code)?;
        let found = members.into_iter().find(|m| m.index == index);
        found
            .map(|m| m.identity)
            .ok_or_else(|| "rejected".to_string())
    }
}
