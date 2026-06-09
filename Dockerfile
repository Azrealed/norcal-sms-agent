FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install && npm rebuild better-sqlite3

COPY . .
RUN npm rebuild better-sqlite3

EXPOSE 8080

CMD node seed-db.js && node server.js
