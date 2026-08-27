# Providers

## AI

The only AI provider is RouterAI. Application code depends on `AiProvider` and receives RouterAI through `AiService`. Configuration uses `ROUTERAI_*` environment variables. Local development can use the deterministic fallback when RouterAI secrets are absent.

## WhatsApp

The only WhatsApp provider is Wazzup. Stage 1 does not send real WhatsApp traffic. Wazzup adapter files exist to preserve the architecture and must be finalized from official Wazzup documentation before Stage 3.

## Forbidden Replacements

- No OpenAI API.
- No OpenRouter.
- No Meta WhatsApp Cloud API as primary channel.
- No WhatsApp Web or browser automation.
