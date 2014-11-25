REST API for SwarmJS
====================

## API

### Read single data object

Requesting `Mouse` instance with id = `A~GoImd`:
```
GET /Mouse%23A~GoImd HTTP/1.0
```
Response: `{"/Mouse#A~GoImd":{"x":200,"y":10,"symbol":"X","ms":0}}`

### Read multiple data objects

Requesting two `Mouse` instances with ids in (`A~GoImd`, `A000un`):
```
GET /Mouse%23A~GoImd%23A000un HTTP/1.0
```
Response: `{"/Mouse#A~GoImd":{"x":200,"y":10,"symbol":"X","ms":0},"/Mouse#A000un":{"x":46,"y":203,"symbol":"Y","ms":0}}`

### Run some operation

Running `set` operation of `Mouse` instance with id = `A~GoImd` and passing json `{x:150,y:150}` as a parameter.

Request:
```
POST /Mouse%23A~GoImd.set HTTP/1.0
Content-Type: application/json
{"x":150,"y":150}
```

Response: `{}`

## Code samples

### Creating request-handler

```js
var api = require('swarm-restapi');
var handler = api.createHandler({
    route: '/',
    host: swarmHost // Swarm.Host instance
    // authenticate: function authenticateUser(req, cb) { cb(null, 'username'); },
});
```

This handler can be used:

  * as an Express.js / Connect middleware;
  * as a standard HttpServer 'request'-event handler;
  * to just get request processing result (without response sending).
