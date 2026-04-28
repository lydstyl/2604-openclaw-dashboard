FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --production

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Don't copy .env into the image — it must be mounted at runtime
RUN rm -f .env

EXPOSE 3015
CMD ["node", "index.js"]