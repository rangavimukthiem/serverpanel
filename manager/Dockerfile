FROM node:20-alpine

# Install git and docker CLI for automated project cloning and container deployment
RUN apk add --no-cache git docker-cli

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
