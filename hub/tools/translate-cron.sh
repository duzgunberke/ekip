#!/bin/sh
# Nightly: rewrite L1 memories the extractor wrote in Chinese/Japanese (tdai-translate-l1.mjs is
# resumable and single-instance, so overlapping runs exit at once).
K=$(grep -A3 -iE "embedding" ${TDAI_DIR:-/data/ekip/tdai}/deploy/global-images/.memory-core-config/tdai-gateway.yaml | grep -iE "api_?key" | head -1 | sed -E "s/.*: *\"?([^\" ]+)\"?.*/\1/")
docker cp ${HUB_DIR:-/data/ekip/hub}/tools/tdai-translate-l1.mjs tdai-memory-core:/app/translate-l1.mjs
docker exec -w /app -e LLM_URL=http://freellmapi:3001/v1 -e LLM_KEY="$K" -e LLM_MODEL=auto:translate -e EMBED_MODEL=nemotron-3-embed-1b tdai-memory-core node --import tsx /app/translate-l1.mjs
