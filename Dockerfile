FROM semtech/mu-javascript-template:1.3.5
LABEL maintainer="Jonathan Langens <flowofcontrol@gmail.com>"

# see https://github.com/mu-semtech/mu-javascript-template for more info
RUN npm install --save docker-hub-api
RUN npm install --save sync-request
