// Root entry point for @lyzr/cloudrift.
//
// This mirrors the Python package's top-level __init__.py, which re-exports
// everything at the package root. For now only the core surface (the unified
// error tree and the lazy-import helper) exists.
//
// As each domain module lands (storage, messaging, cache, secrets, pubsub,
// document), add its `export * from "./<module>/index.js";` line below so the
// root entry re-exports all factories, backends, clients, errors, and types.
// See ARCHITECTURE.md section 4.8 for the full intended root surface.
export * from "./core/index.js";
