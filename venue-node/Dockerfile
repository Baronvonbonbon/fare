# Shared image for the venue-node services (agent F3, relay F8, scorer F5, push
# B4). --env-file loads .env at runtime; the command is chosen by docker-compose.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY agent.mjs relay.mjs scorer.mjs push.mjs economics.mjs ./
# The deployed address book is mounted at /deployed-addresses.json by compose
# (a volume, so redeploys update it without a rebuild) and selected via
# ADDRESS_BOOK. Command is provided by docker-compose (agent.mjs or relay.mjs).
CMD ["node", "--env-file=.env", "agent.mjs"]
