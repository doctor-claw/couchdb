// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.

var resolveModule = function(names, mod, root) {
  if (names.length == 0) {
    if (typeof mod.current != "string") {
      throw ["error","invalid_require_path",
        'Must require a JavaScript string, not: '+(typeof mod.current)];
    }
    return {
      current : mod.current,
      parent : mod.parent,
      id : mod.id,
      exports : {}
    };
  }
  // we need to traverse the path
  var n = names.shift();
  if (n == '..') {
    if (!(mod.parent && mod.parent.parent)) {
      throw ["error", "invalid_require_path", 'Object has no parent '+JSON.stringify(mod.current)];
    }
    return resolveModule(names, {
      id : mod.id.slice(0, mod.id.lastIndexOf('/')),
      parent : mod.parent.parent,
      current : mod.parent.current
    });
  } else if (n == '.') {
    if (!mod.parent) {
      throw ["error", "invalid_require_path", 'Object has no parent '+JSON.stringify(mod.current)];
    }
    return resolveModule(names, {
      parent : mod.parent,
      current : mod.current,
      id : mod.id
    });
  } else if (root) {
    mod = {current : root};
  }
  if (mod.current[n] === undefined) {
    throw ["error", "invalid_require_path", 'Object has no property "'+n+'". '+JSON.stringify(mod.current)];
  }
  return resolveModule(names, {
    current : mod.current[n],
    parent : mod,
    id : mod.id ? mod.id + '/' + n : n
  });
};

var Couch = {
  // moving this away from global so we can move to json2.js later
  compileFunction : function(source, ddoc, name, sandbox) {
    if (!source) throw(["error","not_found","missing function"]);

    var functionObject = null;
    var sandbox = sandbox || create_sandbox();

    var require = function(name, module) {
      module = module || {};
      var newModule = resolveModule(name.split('/'), module.parent, ddoc);
      if (!ddoc._module_cache.hasOwnProperty(newModule.id)) {
        // create empty exports object before executing the module,
        // stops circular requires from filling the stack
        ddoc._module_cache[newModule.id] = {};
        var s = "(function (module, exports, require) { " + newModule.current + "\n });";
        try {
          var func = sandbox ? evalcx(s, sandbox, newModule.id) : eval(s);
          func.apply(sandbox, [newModule, newModule.exports, function(name) {
            return require(name, newModule);
          }]);
        } catch(e) {
          throw [
            "error",
            "compilation_error",
            "Module require('" +name+ "') raised error " + errstr(e)
          ];
        }
        ddoc._module_cache[newModule.id] = newModule.exports;
      }
      return ddoc._module_cache[newModule.id];
    };

    if (ddoc) {
      sandbox.require = require;
      if (!ddoc._module_cache) ddoc._module_cache = {};
    }

    try {
      if(typeof CoffeeScript === "undefined") {
        var rewrittenFun = rewriteFunInt(source);
        functionObject = evalcx(rewrittenFun, sandbox, name);
      } else {
        var transpiled = CoffeeScript.compile(source, {bare: true});
        functionObject = evalcx(transpiled, sandbox, name);
      }
    } catch (err) {
      throw([
        "error",
        "compilation_error",
        errstr(err) + " (" + source + ")"
      ]);
    };
    if (typeof(functionObject) == "function") {
      return functionObject;
    } else {
      throw(["error","compilation_error",
        "Expression does not eval to a function. (" + source.toString() + ")"]);
    };
  },
  recursivelySeal: deepFreeze,
};

function errstr(e) {
  // toSource() is a Spidermonkey "special"
  return (e.toSource ? e.toSource() : e.toString());
};

// If we have an object which looks like an Error, then make it so it
// can be json stringified so it keeps the message and name,
// otherwise, most modern JS engine will stringify Error object as
// {}. Unfortnately, because of sandboxing we cannot use `e instanceof
// Error` as the Error object in the sandbox won't technically be the
// same error object as the one from our wrapper JS functions, so we
// use some "ducktyping" to detect the Error.
//
function error_to_json(e) {
    if (typeof e === "object"
        && e != null
        && 'stack' in e
        && 'name' in e
        && 'message' in e
    ) {
        return {'error': e.name, 'message': e.message}
    };
    return e;
}

// prints the object as JSON, and rescues and logs any JSON.stringify() related errors
function respond(obj) {
  try {
    print(JSON.stringify(obj));
  } catch(e) {
    log("Error converting object to JSON: " + e.toString());
    log("error on obj: "+ obj.toString());
  }
};

function log(message) {
  // idea: query_server_config option for log level
  if (typeof message == "xml") {
    message = message.toXMLString();
  } else if (typeof message != "string") {
    message = JSON.stringify(error_to_json(message));
  }
  respond(["log", String(message)]);
};

function isArray(obj) {
  return toString.call(obj) === "[object Array]";
}

function getPropNames(object) {
  if (typeof Reflect === 'undefined') {
    return Object.getOwnPropertyNames(object);
  } else {
    return Reflect.ownKeys(object);
  }
}

function deepFreeze(object) {
    if (Object.isFrozen(object)) {
        return object;
    }
    Object.freeze(object);
    // Retrieve the property names defined on object
    // `Reflect.ownKeys()` gives us all own property name strings as well as
    // symbols, so it is a bit more complete, but it is a newer JS API, so we
    // fall back on `Object.getOwnPropertyNames()` in JS engines that don’t
    // understand symbols yet (SpiderMonkey 1.8.5). It is a safe fallback
    // because until then object keys can only be strings.
    const propNames = getPropNames(object);

    // Freeze properties before freezing self
    for (var i in propNames) {
        const value = object[propNames[i]];

        if ((value && typeof value === "object") || typeof value === "function") {
            deepFreeze(value);
        }
    }
}
