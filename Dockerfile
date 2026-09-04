FROM node:20-bookworm-slim AS deps

WORKDIR /app
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
RUN npm install --omit=dev && npm cache clean --force

COPY scripts ./scripts
COPY --from=build /app/dist ./dist

CMD ["npm", "run", "start"]
