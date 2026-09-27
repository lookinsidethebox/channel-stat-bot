const helloService = require('./hello.service');

function getMessageResponse() {
  return helloService.getHelloWorld();
}

module.exports = { getMessageResponse };