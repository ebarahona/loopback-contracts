# Changelog

## [0.2.0](https://github.com/ebarahona/loopback-contracts/compare/loopback-contracts-v0.1.0...loopback-contracts-v0.2.0) (2026-05-21)


### Features

* add ESM-strict emit support via --esm flag ([a295d2d](https://github.com/ebarahona/loopback-contracts/commit/a295d2db087e88f2ff89af006cede272b52bd588))
* initial v0.1.0 scaffold for @ebarahona/loopback-contracts ([1a0b0e8](https://github.com/ebarahona/loopback-contracts/commit/1a0b0e85000eb8dd8b52e4f9c5f67861efcf31ac))
* plural outputs[] in emitter manifests + multi-output integration proof ([1a079ed](https://github.com/ebarahona/loopback-contracts/commit/1a079ed9041bceb646b1c513103d3d55c5f01fd6))
* register lb4 generators as EMITTER_TAG (tier: lb4-idiom) ([bbacdcb](https://github.com/ebarahona/loopback-contracts/commit/bbacdcbb84570c7cbf4718350c286f49d6504dae))


### Bug Fixes

* 3 pre-publish blockers — TLS-downgrade, undici Agent leak, stale docs ([75854bf](https://github.com/ebarahona/loopback-contracts/commit/75854bfd94247a011362525e5a67fed318f5c45c))
* close 4 Lows from post-cleanup review ([e710c8d](https://github.com/ebarahona/loopback-contracts/commit/e710c8db4b6bd71d2b606a89ba20bc89244bb511))
* close 5 review findings (1 critical security, 2 medium, 1 medium, 1 low) ([795d8d1](https://github.com/ebarahona/loopback-contracts/commit/795d8d102af90d168d02c46bf9364bbeab5eb8e8))
* close 6 review findings on datasource validation (3 medium + 3 low) ([19fdcba](https://github.com/ebarahona/loopback-contracts/commit/19fdcbaffbc900e65f4da87a613424b5162ec970))
* close 7 review findings (loop 1: 1 critical, 2 medium, 4 low) ([9cb157b](https://github.com/ebarahona/loopback-contracts/commit/9cb157bb0af2f55f203d2a6b06b1b6ac5e43abea))
* close all 11 outstanding review findings before v1.0 ship ([06a99aa](https://github.com/ebarahona/loopback-contracts/commit/06a99aa3e9b8328a455e69c952ab7d63c2778580))
* close loop-2 review findings (0 critical, 3 medium, 3 low) ([767b2c8](https://github.com/ebarahona/loopback-contracts/commit/767b2c8cb948358bf410f7ce4a25999a765c07c7))
* close loop-3 review findings (0 critical, 3 medium, 3 low) ([c3b8f32](https://github.com/ebarahona/loopback-contracts/commit/c3b8f32e5e7dbaa0baebf90b89dcd4e33293bfc7))
* close override-routing critical + all cycle-4 deferred items (ship-blockers) ([0f124b4](https://github.com/ebarahona/loopback-contracts/commit/0f124b4ce7185ef88d239e2a1a4d4738eef379c7))
* close Phase 1 Criticals + Phase 2 Mediums from review [#5](https://github.com/ebarahona/loopback-contracts/issues/5) ([efcf7a6](https://github.com/ebarahona/loopback-contracts/commit/efcf7a6c6e1b4367ba7d7177de0f13bba9fdf69b))
* close two datasource validation gaps before v1.0 ([fbcffeb](https://github.com/ebarahona/loopback-contracts/commit/fbcffebd20615d1da50e7a791b62dd3a27def1de))
* cycle-1 review findings (3 critical, 6 medium, 3 low) ([eff23be](https://github.com/ebarahona/loopback-contracts/commit/eff23bee40a722eee67fac1a7a23d671666aa543))
* cycle-2 review findings (0 critical, 4 medium, 4 low) ([95c61ec](https://github.com/ebarahona/loopback-contracts/commit/95c61ecd313e96e20185ce396004854091d83585))
* cycle-3 review findings (1 critical, 3 medium, 3 low) ([5789405](https://github.com/ebarahona/loopback-contracts/commit/578940542011764ef780279102dbf2f1b1a0ea42))
* cycle-4 review findings + ship-ready polish (0 critical, 2 medium, 1 low) ([87a15bc](https://github.com/ebarahona/loopback-contracts/commit/87a15bc58a53f2ac434b4cfa3b75c7defec4a69d))
* dynamic emit flags + override project-root + lb-contracts text ([7649a59](https://github.com/ebarahona/loopback-contracts/commit/7649a598b12879f8291394041e980acf237bfa9b))
* scrub remaining lb4 references to silence review noise ([4053a89](https://github.com/ebarahona/loopback-contracts/commit/4053a890de7cc0d832198fec3b8b20abd74578e4))
* security hardening — 7 findings closed before publish ([4b6372d](https://github.com/ebarahona/loopback-contracts/commit/4b6372d03fbdf1a255013f78aef735b7a6a3f40c))
* support per-project outputScope so datasource emitter survives multi-schema runs ([122bed0](https://github.com/ebarahona/loopback-contracts/commit/122bed0ccb826726ff28482d4bcbf443a8ab13ab))
* two functional bugs unit tests missed — bin shim no-op + validate missing bindings ([d529da2](https://github.com/ebarahona/loopback-contracts/commit/d529da2a591645002ab0f1621230294516d514f4))
* validate lifecycle + override.ts shared-loader drift (1 critical, 2 medium, 1 low) ([d0ebc54](https://github.com/ebarahona/loopback-contracts/commit/d0ebc54fe59bce4b8d4a5bb1ee0010c35af59538))
* wire security.http.* config end-to-end + correct env var docs ([da736d5](https://github.com/ebarahona/loopback-contracts/commit/da736d589908945482ff8b8ffd49e3fb4749b7f0))


### Documentation

* close all 41 tsdoc/syntax lint warnings ([7d3a21a](https://github.com/ebarahona/loopback-contracts/commit/7d3a21ac3c9ad740365a4f48e5e655482eee166c))
* fix three README drifts vs current behaviour ([46685d6](https://github.com/ebarahona/loopback-contracts/commit/46685d65a17f01feaacb68d34d4ea03fa3050ae0))
* humanize the README opener — sell the workflow, not the architecture ([8d19eb2](https://github.com/ebarahona/loopback-contracts/commit/8d19eb23fc5fdfbc5e7c86457e81ad77dac9c411))
* lead with the actual value prop, drop AI tells ([da969d4](https://github.com/ebarahona/loopback-contracts/commit/da969d4e8a8e1804f4006fc64020160f0e75f08a))
* **readme:** 'The full picture' -&gt; 'Try it' ([6d19cda](https://github.com/ebarahona/loopback-contracts/commit/6d19cda268e30aefc9e8aa13cc863e1cc8ac4339))
* **readme:** fix authoring-workflow lie in 'The full picture' ([f4ea386](https://github.com/ebarahona/loopback-contracts/commit/f4ea38639177db0de66fc3031534439e821d1122))
* **readme:** lead with contract-first pipeline and three entry points ([36dfc88](https://github.com/ebarahona/loopback-contracts/commit/36dfc887cfad91f92a6cbe41f3e5e12a504ab4bf))
* **readme:** point to overrides immediately after gen output ([aecfb55](https://github.com/ebarahona/loopback-contracts/commit/aecfb55c42022533e77a0fad6aba2e6ac4d0c739))
* **readme:** show editable files alongside .base.* in Quickstart output ([224b6cc](https://github.com/ebarahona/loopback-contracts/commit/224b6cc5f67e59ca445ad856652bcf0d0b290bbd))
* **readme:** top-level Quickstart with two examples; collapsible sections ([733475e](https://github.com/ebarahona/loopback-contracts/commit/733475e8186faab17f3c1a4f5185a5d168008ef5))
* rewrite README to LoopBack 4 TLDR style; move deep refs to docs/ ([30f389d](https://github.com/ebarahona/loopback-contracts/commit/30f389da49d1063f42120dc304b0890cd8e3695a))

## Changelog

This file is auto-managed by [release-please](https://github.com/googleapis/release-please). Do not hand-edit. Entries are derived from Conventional Commit subjects on the release branch.
