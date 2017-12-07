# dispatch-management

Wrapper for connecting to and managing a qpid dispatch router.
- Correlates response messages with the calling function.
- Sets up sender and a dynamic receiver to $management.
- Provides a promise interface as well as a callback interface.
- Provides ability to periodically poll for changed data and notifications for when polls are complete.
- Provides ability to make management method calls UPDATE/ADD/DELETE

This library uses the rhea javascript client library.

npm install dispatch-management --save

in your index.html:

    <script src="node_modules/dispatch-management/dist/dispatch-management.js" type="text/javascript"></script>

in a .js file:

    var dm = require("dispatch-management")
    var management = new dm.Management('http')  //  use http (or https)

    var connectOptions = {
        address: '0.0.0.0', 
        port: 5673, 
        reconnect: true, 
        properties: {client_id: 'my app connection properties'},  // optional
        hostname: 'my.domain.com'                                 // optional
    }
    // example of promise interface usage
    management.connection.connect(connectOptions)
      .then(function (response) {
        console.log("connected to dispatch network on " + host + ":" + port)
        // example of callback interface
        management.getSchema(function (schema) {
          console.log("got schema")
        })
      }, function (error) {
        console.log("unable to connect" + error.msg)      
      })
 
