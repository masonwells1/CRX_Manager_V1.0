// Root entry point for eslint-plugin-local-rules.
// This file exists because the project uses "type": "module" so require()
// cannot resolve eslint-local-rules/index.js — it needs a .cjs file.
module.exports = require('./eslint-local-rules/index.cjs');
