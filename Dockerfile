FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN apt-get update && apt-get install -y ffmpeg
COPY . .
EXPOSE 7575
CMD ["node", "app.js"]