# Third-party notices

- `vendor/widget`: dsh-whale-widget 0.4.2 code, MIT. The upstream LICENSE and PROVENANCE remain intact. Bundled default media is generated for this project; see `vendor/widget/ASSET_ADAPTATION.md` for the current asset sources and scope.
- `assets/persona.md`: adapted from the whale companion DSH preset, MIT. The full license is in `assets/persona-LICENSE`.
- `assets/icons`: Tabler Icons, MIT. The full license is in `assets/icons/LICENSE`.
- Default ocean and companion illustrations: generated for this project with image_gen.
- Default QQ stickers: drawn by `scripts/generate-stickers.mjs` for this project.

Custom voices, recordings, portraits and sticker catalogs are supplied and managed locally by each installation. See `docs/assets.md`.

## External services and model references

The documented reference deployment connects to [VoiceStudio](https://github.com/debpalash/VoiceStudio), [audio.cpp](https://github.com/0xShug0/audio.cpp), [Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts) and [NapCatQQ](https://github.com/NapNeko/NapCatQQ) through service interfaces. Their executables and model weights are managed separately from this plugin's package. Each component retains its own license; Breeze TTS 2 model weights, derivative models and self-hosted outputs are subject to its research and non-commercial terms. Consult the linked upstream license notices for the applicable scope.
