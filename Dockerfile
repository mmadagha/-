FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY package.json ./
COPY server.js ./

# بدون dependency: هیچ npm install لازم نیست
USER node

EXPOSE 8080

CMD ["node", "server.js"]
