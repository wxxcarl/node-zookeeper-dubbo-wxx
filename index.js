'use strict';
const net         = require('net');
const hessian     = require('hessian.js');
const url         = require('url');
const zookeeper   = require('node-zookeeper-client');
const qs          = require('querystring');
const Promise     = global.Promise || require('Promise');
const DEFAULT_LEN = 8388608; // 8 * 1024 * 1024

var ZK, Service, ERROR;

ERROR={
  '100': 'create buffer failed ',
  '102': 'connect service error ',
  '103': 'not found service ',
  '104': 'method not found ',
  '105': 'socket connection error ',
  '106': 'service response error ',
  '107': 'service void return ',
  '108': 'bad or unexpected arguments ',
  '109': 'hessian decoder error ',
  '110': 'socket closed ',
}

/**
 * [ZK get zookeeper info]
 * @param {[string]} conn 
 * @param {[string]} env  
 */
ZK = function(conn, env){
  if(ZK.instance) return ZK.instance;
  this.conn    = conn;
  this.env     = env;
  this.methods = [];
  this.cached  = {};
  this.connect();
  ZK.instance  = this;
}

ZK.prototype={
  connect:function(){
    this.client = zookeeper.createClient(this.conn, {
      sessionTimeout: 30000,
      spinDelay     : 1000,
      retries       : 5
    });
    this.client.connect();
    this.client.once('connected', function connect() {
      console.log('zookeeper connected');
    });
  },
  getZooInfo:function(group, path){
    var _this = this;
    return new Promise(function(resolve, reject){
      _this.client.getChildren('/dubbo/' + path + '/providers', function(err, children){
        var zoo, urlParsed;
        if (err) {
          // 102 connect service error
          return reject({code:'102', error:ERROR['102']+(err.name||err)});
        }
        // 103 not found service 
        if (children && !children.length) {
          return reject({code:'103', error:ERROR['103']+ path});
        }

        for (var i = 0, l = children.length; i < l; i++) {
          zoo = qs.parse(decodeURIComponent(children[i]));
          if (zoo.version === _this.env) {
            break;
          }
        }

        // get the first zoo
        urlParsed           = url.parse(Object.keys(zoo)[0]);
        _this.methods[path] = zoo.methods.split(',');
        zoo                 = {host: urlParsed.hostname, port: urlParsed.port};
        _this.cacheZoo(path, zoo);
        return resolve(zoo)
      });
    });
  },
  close:function(){
    this.client.close();
  },
  cacheZoo:function(path, zoo){
    this.cached[path] = zoo;
  }
}

/**
 * [Service Create api service ]
 * @param {[json]} opt [config]
 */
Service = function(opt){
  this._path    = opt.path;
  this._version = opt.version || '2.5.3.4';
  this._env     = opt.env.toUpperCase();
  this._group   = opt.group || '';
  this._conn    = opt.conn;
  this.zk       = new ZK(this._conn, this._env);
}


Service.prototype={
  excute:function(method, args){
    var _this = this, buffer;

    return new Promise(function(resolve, reject){
      try{
        buffer = _this._createBuffer(method, args);
      }catch(e){
        reject({code:'100', error:e.message || ERROR['100']});
      }

      // connect service & fetchData
      if(_this.zk.cached.hasOwnProperty(_this._path)){
        _this._fetchData.bind(_this)(_this.zk.cached[_this._path], buffer, method)
          .then(function(data){
            return resolve(data);
          })
          .catch(function(err){
            return reject(err);
          });
      }else{
        _this.zk.getZooInfo(_this._group, _this._path)
          .then(function(zoo){
            _this._fetchData.bind(_this)(zoo, buffer,  method)
              .then(function(data){
                return resolve(data);
              })
              .catch(function(err){
                return reject(err);
              });
          })
          .catch(function(err){
            return reject(err);
          });
      }
    })
  },
  _fetchData:function(zoo, buffer, method){
    var _this = this;

    return new Promise(function(resolve, reject){
      var client   = new net.Socket();
      var bl       = 16;
      var host     = zoo.host;
      var port     = zoo.port;
      var ret      = null;
      var chunks   = [];
      var tryCount = 0;
      var heap;

      // 104 method not found
      if (!~_this.zk.methods[_this._path].indexOf(method)) {
        return reject({code:'104', error:ERROR['104']+method});
      }

      client.connect(port, host, function () {
        client.write(buffer);
      });

      client.on('data', function (chunk) {
        var heap, ret;

        client.destroy();

        if (!chunks.length) {
          var arr = Array.prototype.slice.call(chunk.slice(0, 16));
          var i   = 0;
          while (i < 3) {
            bl += arr.pop() * Math.pow(255, i++);
          }
        }
        chunks.push(chunk);
        heap = Buffer.concat(chunks);

        // 106 service response error
        if (heap[3] !== 20) {
          ret = heap.slice(18, heap.length - 1).toString();
          return reject({code: '106', error:ERROR['106']+ret});
        }

        // 107 service void return
        if (heap[3]===20 && heap[15] === 1) {
          return resolve(true);
        }

        try {
          var offset = heap[16] === 145 ? 17 : 18;
          var buf    = new hessian.DecoderV2(heap.slice(offset, heap.length));
          var _ret   = buf.read();
          if (_ret instanceof Error || offset === 18) {
            return reject({code:'108', error:ERROR['108']+(_ret.message||_ret)});//108 hessian read error
          }
          return resolve(_ret);
        } catch(err) {
          return reject({code:'109', error:ERROR['109']+(err.message || err)});//109 hessian decoder error
        }
      });

      // 105 socket connection error 
      client.on('error', function (err) {
        client.destroy();
        return reject({code:'105', error:ERROR['105'] + (err.message || err)});
      });

      // 110 socket closed
      client.on('close', function (err){
        // console.log('socket closed');
        return reject({code:'110', error:ERROR['110']+(err.message || '')});
      });

      client.on('timeout',function(){
        client.destroy();
        console.log('socket  timeout');
      })

    })
  },
  _createBuffer:function(method, args){
    var typeRef, types, type, buffer;

    typeRef = {
      boolean: 'Z', int: 'I', short: 'S',
      long   : 'J', double: 'D', float: 'F'
    };

    if (args && args.length) {
      for (var i = 0, l = args.length; i < l; i++) {
        type = args[i]['$class'];
        types += type && ~type.indexOf('.')
          ? 'L' + type.replace(/\./gi, '/') + ';'
          : typeRef[type];
      }
      buffer = this.buffer(method, types, args);
    } else {
      buffer = this.buffer(method, '');
    }

    return buffer;
  },
  buffer:function(method, type, args){
    var bufferBody = this.bufferBody(method, type, args);
    var bufferHead = this.bufferHead(bufferBody.length);
    return Buffer.concat([bufferHead, bufferBody]);
  },
  bufferHead:function(length){
    var head = [0xda, 0xbb, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var i    = 15;

    if (length > DEFAULT_LEN) {
      throw new Error(`Data length too large: ${length}, max payload: ${DEFAULT_LEN}`);
    }
    // 构造body长度信息
    if (length - 256 < 0) {
      head.splice(i, 1, length - 256);
    } else {
      while (length - 256 > 0) {
        head.splice(i--, 1, length % 256);
        length = length >> 8;
      }
      head.splice(i, 1, length);
    }
    return new Buffer(head);
  },
  bufferBody:function(method, type, args){
    var encoder = new hessian.EncoderV2();
    encoder.write(this._version);
    encoder.write(this._path);
    encoder.write(this._env);
    encoder.write(method);
    encoder.write(type);

    if (args && args.length) {
      for (var i = 0, len = args.length; i < len; ++i) {
        encoder.write(args[i]);
      }
    }

    encoder.write({
      $class: 'java.util.HashMap',
        $     : {
          interface: this._path,
          version  : this._env,
          group    : this._group,
          path     : this._path,
          timeout  : '60000'
        }
    });

    encoder = encoder.byteBuffer._bytes.slice(0, encoder.byteBuffer._offset);

    return encoder;
  }
}

module.exports = Service;