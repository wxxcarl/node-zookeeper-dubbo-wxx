# node-zookeeper-dubbo
nodejs connect dubbo by default protocol in zookeeper

** Modified on the basis of [node-zookeeper-dubbo](https://github.com/p412726700/node-zookeeper-dubbo) **

### config
##### env
dubbo service version
##### conn
zookeeper conn url
##### path
the service you need
##### version
dubbo version

### Example
```javascript
var Service=require('node-zookeeper-dubbo');

var opt={
  env:'test', // dubbo service version
  gruop:'dubbo', // dubbo group default by 'dubbo',optional
  conn:'127.0.0.1:2180', // zookeeper url
  path:'com.customer.Service', // service url
  version:'2.3.4.5' // dubbo version
}

var method="getUserByID";
var arg1={$class:'int',$:123}
var args=[arg1];

var service = new Service(opt);
service.excute(method,args,function(err,data){
  if(err){
    console.log(err);
    return;
  }
  console.log(data)
})

or

service
  .excute(method,args)
  .then(function(data){
    console.log(data);
  })
  .catch(function(err) {
    console.log(err);
  })

```
you can use  [js-to-java](https://github.com/node-modules/js-to-java)
```javascript
var arg1={$class:'int',$:123};
//equivalent
var arg1=java('int',123);
```