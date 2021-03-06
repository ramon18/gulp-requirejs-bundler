var es = require('event-stream'),
    merge = require('deeply'),
    rjs = require('gulp-requirejs'),
    Vinyl = require('vinyl'),
    Q = require('q'),
    _ = require('underscore'),
    chalk = require('chalk'),
    log = console.log;

module.exports = function(options) {

    // Get a list of all the modules that will be included in the bundles,
    // so that they can be excluded from the primary output
    var allBundledModules = _.flatten(_.values(options.bundles));
    
    // Capture (optional) bundles
    var bundles = cut(options, 'bundles') || {};

    // Capture (optional) extra fields to inject on final require.config({ ... })
    var requireConfig = cut(options, 'requireConfig') || {};
    
    // Capture (optional) prefix/suffix applied when naming bundles (including main)
    var bundleSuffix = cut(options, 'bundleSuffix') || "";
    var bundlePrefix = cut(options, 'bundlePrefix') || "";

    // Helper function to generate bundle name
    function makeBundleName(name) {
        if (!name) return name;
        
        var m = /\.js$/i.exec(name);
        if (m) {
            name = name.substring(0, m.index);
        }
        return bundlePrefix + name + bundleSuffix + ".js";
    }

    // Fix main bundle output name
    options.out = makeBundleName(options.out);
    
    // First run r.js to produce its default (non-bundle-aware) output. In the process,
    // we capture the list of modules it wrote.
    var primaryPromise = getRjsOutput(merge({}, options, {
        excludeShallow: allBundledModules
    }), options.name);

    // Next, take the above list of modules, and for each configured bundle, write out
    // the bundle's .js file, excluding any modules included in the primary output. In
    // the process, capture the list of modules included in each bundle file.
    var bundlePromises = _.map(bundles, function(bundleModules, bundleName) {
            return primaryPromise.then(function(primaryOutput) {
                return getRjsOutput(merge({}, options, {
                    out: makeBundleName(bundleName),
                    include: bundleModules,
                    excludeShallow: primaryOutput.modules.concat(allBundledModules).filter(function (x) {
                        return bundleModules.indexOf(x) === -1;
                    }),
                    insertRequire: null
                }), bundleName);
            });
        });

    // Next, produce the "final" primary output by waiting for all the above to complete, then
    // concatenating the bundle config (list of modules in each bundle) to the end of the
    // primary file.
    var finalPrimaryPromise = Q.all([primaryPromise].concat(bundlePromises)).then(function(allOutputs) {
            var primaryOutput = allOutputs[0],
                bundleOutputs = allOutputs.slice(1),
                bundleConfig = _.object(bundleOutputs.map(function(bundleOutput) {
                    return [bundlePrefix + bundleOutput.itemName + bundleSuffix, bundleOutput.modules]
                })),
                bundleConfigCode = '\nrequire.config('
                    + JSON.stringify(merge(requireConfig, { bundles: bundleConfig }), true, 2)
                    + ');\n';
            return new Vinyl({
                path: primaryOutput.file.path,
                contents: new Buffer(primaryOutput.file.contents.toString() + bundleConfigCode)
            });
        }).catch(function(err) {
            var stream = es.pause();
            stream.emit('error', err);
            return stream;
        });

    // Convert the N+1 promises (N bundle files, 1 final primary file) into a single stream for gulp to await
    var allFilePromises = pluckPromiseArray(bundlePromises, 'file').concat(finalPrimaryPromise);
    return es.merge.apply(es, allFilePromises.map(promiseToStream));
}

function promiseToStream(promise) {
    var stream = es.pause();
    promise.then(function(result) {
        stream.resume();
        stream.end(result);
    }, function(err) {
        throw err;
    });
    return stream;
}

function cut(o, prop) {
    var result = o[prop];
    delete o[prop];
    return result;
}

function streamToPromise(stream) {
    // Of course, this relies on the stream producing only one output. That is the case
    // for all uses in this file (wrapping rjs output, which is always one file).
    var deferred = Q.defer();
    stream.on('error', function(error){
        deferred.reject(error);
    }).pipe(es.through(function(item) {
        deferred.resolve(item);
    }));
    return deferred.promise;
}

function pluckPromiseArray(promiseArray, propertyName) {
    return promiseArray.map(function(promise) {
        return promise.then(function(result) {
            return result[propertyName];
        });
    });
}

function getRjsOutput(options, itemName) {

    // Capture the list of written modules by adding to an array on each onBuildWrite callback
    var modulesList = [],
        patchedOptions = merge({}, options, {
            onBuildWrite: function(moduleName, path, contents) {
                modulesList.push(moduleName);
                return contents;
            }
        });

    return streamToPromise(rjs(patchedOptions)).then(function(file) {

        if (options.verbose) {
            log(chalk.yellow('Generated bundle ') + chalk.green.underline(itemName) + chalk.yellow(", modules included:"))
            for (var i = 0; i < modulesList.length; i++) {
                log(chalk.green(" > ") + modulesList[i]);           
            }
        }
    
        return { itemName: itemName, file: file, modules: modulesList };
    });
}
