# Shared image for the agent (F3) and relay (F8). Both are single-file Node
# scripts whose only dependency is ethers; --env-file loads .env at runtime.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY agent.mjs relay.mjs scorer.mjs ./
# The deployed address book is mounted at /deployed-addresses.json by compose
# (a volume, so redeploys update it without a rebuild) and selected via
# ADDRESS_BOOK. Command is provided by docker-compose (agent.mjs or relay.mjs).
CMD ["node", "--env-file=.env", "agent.mjs"]
