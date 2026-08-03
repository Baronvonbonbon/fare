# Shared image for the venue-node services (agent F3, relay F8, scorer F5, push
# B4). Configuration arrives as ENVIRONMENT VARIABLES, injected by compose's
# `env_file:` — NOT as a mounted .env. `.dockerignore` excludes .env on purpose,
# because it holds RELAY_PRIVATE_KEY and an image is a shipping artifact.
#
# So do NOT add `--env-file=.env` here or to a compose command. It was there
# until 2026-08-03 and made every service in this file crash-loop on
# `node: .env: not found` — the flag needs a file that cannot exist in the image
# by design, while the variables it would have loaded are already in the
# environment.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Every runtime module, not just the entry points — agent.mjs imports rpc.mjs,
# and relay.mjs imports swap.mjs + treasury.mjs (which import economics.mjs).
# Omitting them built an image that started and then died on ERR_MODULE_NOT_FOUND.
# Listed explicitly rather than `COPY *.mjs` so the *.test.mjs files stay out of
# a shipped image; if you add a module here, add it to this line.
COPY agent.mjs relay.mjs scorer.mjs push.mjs economics.mjs rpc.mjs swap.mjs treasury.mjs ./
# The deployed address book is mounted at /deployed-addresses.json by compose
# (a volume, so redeploys update it without a rebuild) and selected via
# ADDRESS_BOOK. Command is provided by docker-compose (agent.mjs or relay.mjs).
CMD ["node", "agent.mjs"]
