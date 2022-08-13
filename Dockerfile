FROM node:lts-alpine as base
FROM base as builder
RUN mkdir /install
WORKDIR /install
COPY package.json .
RUN npm i --production
FROM base
COPY --from=builder /install/node_modules ./node_modules
COPY ./ /app
ENV NODE_WORKDIR /app
WORKDIR $NODE_WORKDIR
CMD ["node", "index.js"]
