(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory); // AMD. Register as an anonymous module.
  } else if (typeof exports === 'object') {
    module.exports = factory(); // NodeJS
  } else { // Browser globals (root is window)
    root.flyd = factory();
  }
}(this, function () {

'use strict';

function isFunction(obj) {
  return !!(obj && obj.constructor && obj.call && obj.apply);
}

function notUndef(v) {
  return v !== undefined;
}

function each(fn, list) {
  for (var i = 0; i < list.length; ++i) fn(list[i]);
}

var toUpdate = [];
var inStream;

function map(s, f) {
  return stream([s], function(self) { self(f(s())); });
}

var scan = curryN(3, function(f, acc, s) {
  var ns = stream([s], function() {
    return (acc = f(acc, s()));
  });
  if (!ns.hasVal) ns(acc);
  return ns;
});

var merge = curryN(2, function(s1, s2) {
  var s = immediate(stream([s1, s2], function(n, changed) {
    return changed[0] ? changed[0]()
         : s1.hasVal  ? s1()
                      : s2();
  }));
  endsOn(stream([s1.end, s2.end], function(self, changed) {
    return true;
  }), s);
  return s;
});

function ap(s2) {
  var s1 = this;
  return stream([s1, s2], function() { return s1()(s2()); });
}

function initialDepsNotMet(stream) {
  if (!stream.depsMet) {
    stream.depsMet = stream.deps.every(function(s) {
      return s.hasVal;
    });
  }
  return !stream.depsMet;
}

function updateStream(s) {
  if (initialDepsNotMet(s) || (s.end && s.end())) return;
  inStream = s;
  var returnVal = s.fn(s, s.depsChanged);
  if (notUndef(returnVal)) {
    s(returnVal);
  }
  inStream = undefined;
  s.depsChanged = [];
}

function findDeps(order, s) {
  if (!s.queued) {
    s.queued = true;
    each(findDeps.bind(null, order), s.listeners);
    order.push(s);
  }
}

function updateDeps(s) {
  var i, order = [];
  each(function(list) {
    list.end === s ? endStream(list)
                   : (list.depsChanged.push(s), findDeps(order, list));
  }, s.listeners);
  for (i = order.length - 1; i >= 0; --i) {
    if (order[i].depsChanged.length > 0) {
      updateStream(order[i]);
    }
    order[i].queued = false;
  }
}

function flushUpdate() {
  while (toUpdate.length > 0) updateDeps(toUpdate.shift());
}

function isStream(stream) {
  return isFunction(stream) && 'hasVal' in stream;
}

function streamToString() {
  return 'stream(' + this.val + ')';
}

function createStream() {
  function s(n) {
    if (arguments.length > 0) {
      if (n && isFunction(n.then)) {
        n.then(s);
        return;
      }
      s.val = n;
      s.hasVal = true;
      if (inStream !== s) {
        toUpdate.push(s);
        if (!inStream) flushUpdate();
      } else {
        each(function(list) {
          list.end === s ? endStream(list) : list.depsChanged.push(s);
        }, s.listeners);
      }
      return s;
    } else {
      return s.val;
    }
  }
  s.hasVal = false;
  s.val = undefined;
  s.listeners = [];
  s.queued = false;
  s.end = undefined;

  s.map = map.bind(null, s);
  s.ap = ap;
  s.of = stream;
  s.toString = streamToString;

  return s;
}

function createDependentStream(deps, fn) {
  var s = createStream();
  s.fn = fn;
  s.deps = deps;
  s.depsMet = false;
  s.depsChanged = [];
  each(function(dep) { dep.listeners.push(s); }, deps);
  return s;
}

function immediate(s) {
  if (s.depsMet === false) {
    s.depsMet = true;
    updateStream(s);
    flushUpdate();
  }
  return s;
}

function removeListener(s, listeners) {
  var idx = listeners.indexOf(s);
  listeners[idx] = listeners[listeners.length - 1];
  listeners.length--;
}

function detachDeps(s) {
  each(function(dep) { removeListener(s, dep.listeners); }, s.deps);
  s.deps.length = 0;
}

function endStream(s) {
  if (s.deps) detachDeps(s);
  if (s.end) detachDeps(s.end);
}

function endsOn(endS, s) {
  detachDeps(s.end);
  endS.listeners.push(s.end);
  s.end.deps.push(endS);
  return s;
}

function stream(arg, fn) {
  var s, deps;
  var endStream = createDependentStream([], function() { return true; });
  if (arguments.length > 1) {
    deps = arg.filter(notUndef);
    s = createDependentStream(deps, fn);
    s.end = endStream;
    endStream.listeners.push(s);
    var depEndStreams = deps.map(function(d) { return d.end; }).filter(notUndef);
    endsOn(createDependentStream(depEndStreams, function() { return true; }, true), s);
    updateStream(s);
    flushUpdate();
  } else {
    s = createStream();
    s.end = endStream;
    endStream.listeners.push(s);
    if (arguments.length === 1) s(arg);
  }
  return s;
}

var transduce = curryN(2, function(xform, source) {
  xform = xform(new StreamTransformer());
  // Latest Ramda release still uses old transducer protocol
  var stepName = xform['@@transducer/step'] ? '@@transducer/step' : 'step';
  return stream([source], function(self) {
    var res = xform[stepName](undefined, source());
    if (res && res['@@transducer/reduced'] === true) {
      self.end(true);
      return res['@@transducer/value'];
    } else {
      return res;
    }
  });
});

function StreamTransformer() { }
StreamTransformer.prototype.init = function() { };
StreamTransformer.prototype.result = function() { };
StreamTransformer.prototype.step = function(s, v) { return v; };
StreamTransformer.prototype['@@transducer/init'] = function() { };
StreamTransformer.prototype['@@transducer/result'] = function() { };
StreamTransformer.prototype['@@transducer/step'] = function(s, v) { return v; };

// Own curry implementation snatched from Ramda
// Figure out something nicer later on
var _ = {placeholder: true};

// Detect both own and Ramda placeholder
function isPlaceholder(p) {
  return p === _ || (p && p.ramda === 'placeholder');
}

function toArray(arg) {
  var arr = [];
  for (var i = 0; i < arg.length; ++i) {
    arr[i] = arg[i];
  }
  return arr;
}

// Modified versions of arity and curryN from Ramda
function ofArity(n, fn) {
  if (arguments.length === 1) {
    return ofArity.bind(undefined, n);
  }
  switch (n) {
  case 0:
    return function () {
      return fn.apply(this, arguments);
    };
  case 1:
    return function (a0) {
      void a0;
      return fn.apply(this, arguments);
    };
  case 2:
    return function (a0, a1) {
      void a1;
      return fn.apply(this, arguments);
    };
  case 3:
    return function (a0, a1, a2) {
      void a2;
      return fn.apply(this, arguments);
    };
  case 4:
    return function (a0, a1, a2, a3) {
      void a3;
      return fn.apply(this, arguments);
    };
  case 5:
    return function (a0, a1, a2, a3, a4) {
      void a4;
      return fn.apply(this, arguments);
    };
  case 6:
    return function (a0, a1, a2, a3, a4, a5) {
      void a5;
      return fn.apply(this, arguments);
    };
  case 7:
    return function (a0, a1, a2, a3, a4, a5, a6) {
      void a6;
      return fn.apply(this, arguments);
    };
  case 8:
    return function (a0, a1, a2, a3, a4, a5, a6, a7) {
      void a7;
      return fn.apply(this, arguments);
    };
  case 9:
    return function (a0, a1, a2, a3, a4, a5, a6, a7, a8) {
      void a8;
      return fn.apply(this, arguments);
    };
  case 10:
    return function (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
      void a9;
      return fn.apply(this, arguments);
    };
  default:
    throw new Error('First argument to arity must be a non-negative integer no greater than ten');
  }
}

function curryN(length, fn) {
  return ofArity(length, function () {
    var n = arguments.length;
    var shortfall = length - n;
    var idx = n;
    while (--idx >= 0) {
      if (isPlaceholder(arguments[idx])) {
        shortfall += 1;
      }
    }
    if (shortfall <= 0) {
      return fn.apply(this, arguments);
    } else {
      var initialArgs = toArray(arguments);
      return curryN(shortfall, function () {
        var currentArgs = toArray(arguments);
        var combinedArgs = [];
        var idx = -1;
        while (++idx < n) {
          var val = initialArgs[idx];
          combinedArgs[idx] = isPlaceholder(val) ? currentArgs.shift() : val;
        }
        return fn.apply(this, combinedArgs.concat(currentArgs));
      });
    }
  });
}


return {
  stream: stream,
  isStream: isStream,
  transduce: transduce,
  merge: merge,
  reduce: scan, // Legacy
  scan: scan,
  endsOn: endsOn,
  map: curryN(2, function(f, s) { return map(s, f); }),
  curryN: curryN,
  _: _,
  immediate: immediate,
};

}));
