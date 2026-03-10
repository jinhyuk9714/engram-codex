FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 57332

CMD ["sh", "-c", "npm run db:init && npm start"]
