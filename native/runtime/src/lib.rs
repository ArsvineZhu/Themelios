use napi::{Error, Result};
use napi_derive::napi;
use std::fs::{File, TryLockError};

/// An exclusive lock tied to one OS file handle.
#[napi]
pub struct InstanceLock {
    file: Option<File>,
}

#[napi]
impl InstanceLock {
    #[napi(factory)]
    pub fn acquire(path: String) -> Result<Self> {
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file: Some(file) }),
            Err(TryLockError::WouldBlock) => Err(Error::from_reason("instance_busy")),
            Err(TryLockError::Error(error)) => Err(Error::from_reason(error.to_string())),
        }
    }

    #[napi]
    pub fn close(&mut self) {
        self.file.take();
    }
}
