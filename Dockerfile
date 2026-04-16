FROM node:lts-alpine as base
FROM base as builder
RUN mkdir /install
WORKDIR /install
COPY package.json .
RUN npm i --production
FROM base
RUN addgroup -S bot && adduser -S bot -G bot
COPY --from=builder /install/node_modules /app/node_modules
COPY ./ /app
ENV NODE_WORKDIR /app
WORKDIR $NODE_WORKDIR
USER bot
CMD ["node", "index.js"]
