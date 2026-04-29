FROM node:20-alpine

# Install build tools needed by sharp + curl to fetch marzipano
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Bundle marzipano so the editor and exported tours work fully offline
RUN curl -fsSL https://cdn.jsdelivr.net/npm/marzipano@0.10.2/dist/marzipano.js \
    -o /app/public/js/marzipano.js

EXPOSE 3098

CMD ["node", "server/index.js"]
