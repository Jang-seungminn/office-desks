//! A scripted [`OrcaRunner`] for unit tests: it records every argv, then answers with a handler.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use od_core::backend::BackendError;
use od_core::util::lock;
use serde_json::{json, Value};

use crate::cli::OrcaRunner;

type Handler = Box<dyn Fn(&[String]) -> Result<Value, BackendError> + Send + Sync>;

pub(crate) struct FakeRunner {
    pub calls: Mutex<Vec<Vec<String>>>,
    /// Per call: the `run_with_timeout` override, or None for a plain `run`.
    pub timeouts: Mutex<Vec<Option<Duration>>>,
    handler: Handler,
}

impl FakeRunner {
    pub fn new(
        handler: impl Fn(&[String]) -> Result<Value, BackendError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            handler: Box::new(handler),
        })
    }

    /// Answers `{}` to everything.
    pub fn ok() -> Arc<Self> {
        Self::new(|_| Ok(json!({})))
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        lock(&self.calls).clone()
    }

    pub fn timeouts(&self) -> Vec<Option<Duration>> {
        lock(&self.timeouts).clone()
    }

    fn answer(&self, args: &[String], timeout: Option<Duration>) -> Result<Value, BackendError> {
        lock(&self.calls).push(args.to_vec());
        lock(&self.timeouts).push(timeout);
        (self.handler)(args)
    }
}

#[async_trait]
impl OrcaRunner for FakeRunner {
    async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
        self.answer(args, None)
    }

    async fn run_with_timeout(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        self.answer(args, Some(timeout))
    }
}

pub(crate) fn argv(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}
