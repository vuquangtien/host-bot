FROM node:20-bookworm-slim AS deps

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install

FROM deps AS build

COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

CMD ["npm", "run", "start"]
