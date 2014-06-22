// https://github.com/chuckremes/nn-core/blob/master/spec/nn_send_spec.rb

var assert = require('assert');
var should = require('should');
var nano = require('../lib');
var nn = nano._bindings;

var test = require('tape');

test('send stream sends data', function (t) {
    t.plan(1);
    var pub = nano.stream('pub');
    var sub = nano.stream('sub');
    pub.bind('tcp://127.0.0.1:7789');
    sub.connect('tcp://127.0.0.1:7789');

    sub.on('data', function(d) {
      t.equal(d.toString(), 'abc');
      pub.close();
      sub.close();
    });

    pub.write('abc')
});


