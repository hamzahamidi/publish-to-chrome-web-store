# Test fixtures

## chromium-packed.crx

A CRX3 written by Chrome for Testing 153 with `--pack-extension`, used by `test/crx.test.ts` to check that the action reads a package Chrome itself produced, not only one from the `sign` action.

- Contents: `manifest.json` (Manifest V3, name "CRX packer check", version 1.2.3) and `bg.js`, a service worker of 50 bytes. No other file.
- SHA-256: `504776aee8e0fd54524b7240b26fb7f33002bfa57278a17f5790612d4c1af9c8`
- Like every CRX, it carries only the public half of the key that signed it.

It is committed as a binary because the point of the test is Chrome's exact output. To make a new one, put those two files in a folder and run `chrome --pack-extension=<folder>`, which writes `<folder>.crx` and a new key; update the hash here and the version the test expects.

The `Signing matches Chrome's packer` CI job compares `sign` with Chrome's packer on every change, so this file is a fixed reference, not the only check.
