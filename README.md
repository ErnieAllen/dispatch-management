# dispatch-management
Management wrapper for qpid dispatch router

npm install dispatch-management --save

in your index.html:
- <script src="node_modules/dispatch-management/dist/dispatch-management.js" type="text/javascript"></script>

in a .js file:
    var dm = require("dispatch-management")
    var management = new dm.Management('http')  //  use http (or https)

    var host = '0.0.0.0', port = 5673;
    var afterConnect = function () {
        console.log("connected to dispatch network on " + host + ":" + port)
        management.getSchema(function () {
          console.log("got schema")
        })
    }
    // register a notification function for when the connection to the router succeeds
    management.connection.addConnectAction(afterConnect);

    var connectOptions = {
        address: host, 
        port: port, 
        reconnect: true, 
        properties: {client_id: 'my app connection properties'},  // optional
        hostname: 'my.domain.com'                                 // optional
    }
    // connect
    management.connection.connect(connectOptions)
    
    
    
