var console = { log: function(){ print(Array.prototype.slice.call(arguments).map(function(a){ return typeof a==='object'? JSON.stringify(a): String(a)}).join(' ')); }, error: function(){ print('ERR ' + Array.prototype.slice.call(arguments).join(' ')); }, warn: function(){ print('WARN ' + Array.prototype.slice.call(arguments).join(' ')); } };
var window = this; var self = this;
