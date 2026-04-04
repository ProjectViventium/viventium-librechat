# RAG API Overrides

This directory contains local file overrides that are bind-mounted into the `rag_api` container for
Viventium-specific runtime behavior.

## Current Overrides

- `app/routes/document_routes.py`
  - Upstream source: `danny-avila/rag_api`
  - Upstream image commit used as the patch base: `9938ee6ebb9bf22e72f34b3d5bec0baa3297bb1c`
  - Viventium behavior:
    - accept request-scoped OpenAI embeddings auth overrides from LibreChat
    - use the override only for the current embed request
    - fall back to the default env-configured embeddings path on auth/config failures

## Why This Exists

The local Viventium launcher uses the published `rag_api` image, but Viventium needs a small,
public-safe extension so conversation recall and other vector uploads can honor the same user-first
OpenAI auth precedence as chat completions.

Until this lands upstream or the component becomes a first-class nested source dependency, the
launcher mounts this override into the running container.
