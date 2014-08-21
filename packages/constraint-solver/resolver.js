var semver = Npm.require('semver');

mori = Npm.require('mori');

BREAK = {};  // used by our 'each' functions

////////////////////////////////////////////////////////////////////////////////
// Resolver
////////////////////////////////////////////////////////////////////////////////

// XXX the whole resolver heavily relies on these statements to be true:
// - every unit version ever used was added to the resolver with addUnitVersion
// - every constraint ever used was instantiated with getConstraint
// - every constraint was added exactly once
// - every unit version was added exactly once
// - if two unit versions are the same, their refs point at the same object
// - if two constraints are the same, their refs point at the same object
ConstraintSolver.Resolver = function (options) {
  var self = this;
  options = options || {};

  self._nudge = options.nudge;

  // Maps unit name string to an array of version definitions
  self.unitsVersions = {};
  // Maps name@version string to a unit version
  self._unitsVersionsMap = {};

  // A set of unit names which have no unit versions (ie, the package does not
  // exist). Note that we only set this for nonexistent packages, not for
  // version-less packages, though maybe that's wrong.
  self._noUnitVersionsExist = {};

  // Maps unit name string to the greatest version string we have
  self._latestVersion = {};

  // Refs to all constraints. Mapping String -> instance
  self._constraints = {};

  // Let's say that we that package P is available from source at version X.Y.Z.
  // Then that's the only version that can actually be chosen by the resolver,
  // and so it's the only version included as a UnitVersion.  But let's say
  // another unit depends on it with a 'compatible-with' dependency "@A.B.C". We
  // need to be able to figure out the earliestCompatibleVersion of A.B.C, even
  // though A.B.C is not a valid (selectable) UnitVersion. We store them here.
  //
  // Maps String unitName -> String version -> String earliestCompatibleVersion
  self._extraECVs = {};
};

ConstraintSolver.Resolver.prototype.addUnitVersion = function (unitVersion) {
  var self = this;

  check(unitVersion, ConstraintSolver.UnitVersion);

  if (_.has(self._noUnitVersionsExist, unitVersion.name))
    throw Error("but no unit versions exist for " + unitVersion.name + "!");

  if (! _.has(self.unitsVersions, unitVersion.name)) {
    self.unitsVersions[unitVersion.name] = [];
    self._latestVersion[unitVersion.name] = unitVersion.version;
  }

  if (! _.has(self._unitsVersionsMap, unitVersion.toString())) {
    self.unitsVersions[unitVersion.name].push(unitVersion);
    self._unitsVersionsMap[unitVersion.toString()] = unitVersion;
  }

  if (semver.lt(self._latestVersion[unitVersion.name], unitVersion.version))
    self._latestVersion[unitVersion.name] = unitVersion.version;
};

ConstraintSolver.Resolver.prototype.noUnitVersionsExist = function (unitName) {
  var self = this;

  if (_.has(self.unitsVersions, unitName))
    throw Error("already have unit versions for " + unitName + "!");
  self._noUnitVersionsExist[unitName] = true;
};



ConstraintSolver.Resolver.prototype.getUnitVersion = function (unitName, version) {
  var self = this;
  return self._unitsVersionsMap[unitName + "@" + version];
};

// name - String - "someUnit"
// versionConstraint - String - "=1.2.3" or "2.1.0"
ConstraintSolver.Resolver.prototype.getConstraint =
  function (name, versionConstraint) {
  var self = this;

  check(name, String);
  check(versionConstraint, String);

  var idString = JSON.stringify([name, versionConstraint]);

  if (_.has(self._constraints, idString))
    return self._constraints[idString];

  return self._constraints[idString] =
    new ConstraintSolver.Constraint(name, versionConstraint);
};

ConstraintSolver.Resolver.prototype.addExtraECV = function (
    unitName, version, earliestCompatibleVersion) {
  var self = this;
  check(unitName, String);
  check(version, String);
  check(earliestCompatibleVersion, String);

  if (!_.has(self._extraECVs, unitName)) {
    self._extraECVs[unitName] = {};
  }
  self._extraECVs[unitName][version] = earliestCompatibleVersion;
};

ConstraintSolver.Resolver.prototype.getEarliestCompatibleVersion = function (
    unitName, version) {
  var self = this;

  var uv = self.getUnitVersion(unitName, version);
  if (uv) {
    return uv.earliestCompatibleVersion;
  }
  if (!_.has(self._extraECVs, unitName)) {
    return null;
  }
  if (!_.has(self._extraECVs[unitName], version)) {
    return null;
  }
  return self._extraECVs[unitName][version];
};

// options: Object:
// - costFunction: function (state, options) - given a state evaluates its cost
// - estimateCostFunction: function (state) - given a state, evaluates the
// estimated cost of the best path from state to a final state
// - combineCostFunction: function (cost, cost) - given two costs (obtained by
// evaluating states with costFunction and estimateCostFunction)
ConstraintSolver.Resolver.prototype.resolve = function (
    dependencies, constraints, options) {
  var self = this;

  constraints = constraints || [];
  var choices = mori.hash_map();  // uv.name -> uv
  options = _.extend({
    costFunction: function (state) { return 0; },
    estimateCostFunction: function (state) {
      return 0;
    },
    combineCostFunction: function (cost, anotherCost) {
      return cost + anotherCost;
    }
  }, options);

  // required for error reporting later.
  // maps Constraint [object identity! thus getConstraint] to list of unit name
  var constraintAncestor = mori.hash_map();
  _.each(constraints, function (c) {
    constraintAncestor = mori.assoc(constraintAncestor, c, mori.list(c.name));
  });

  dependencies = ConstraintSolver.DependenciesList.fromArray(dependencies);
  constraints = ConstraintSolver.ConstraintsList.fromArray(constraints);

  // create a fake unit version to represent the app or the build target
  var fakeUnitName = "###TARGET###";
  var appUV = new ConstraintSolver.UnitVersion(fakeUnitName, "1.0.0", "0.0.0");
  appUV.dependencies = dependencies;
  appUV.constraints = constraints;

  // state is an object:
  // - dependencies: DependenciesList
  // - constraints: ConstraintsList
  // - choices: mori.has_map of unitName to UnitVersion
  // - constraintAncestor: mapping Constraint -> mori.list(unitName)
  var startState = self._propagateExactTransDeps(
    appUV, dependencies, constraints, choices, constraintAncestor);
  // The fake unit version is not a real choice --- remove it!
  startState.choices = mori.dissoc(startState.choices, fakeUnitName);

  if (options.stopAfterFirstPropagation)
    return startState.choices;

  var pq = new PriorityQueue();
  var costFunction = options.costFunction;
  var estimateCostFunction = options.estimateCostFunction;
  var combineCostFunction = options.combineCostFunction;

  var estimatedStartingCost =
    combineCostFunction(costFunction(startState),
                        estimateCostFunction(startState));

  pq.push(startState, [estimatedStartingCost, 0]);

  // Mapping that assigns every package an integer priority. We compute this
  // dynamically and in the process of resolution we try to resolve packages
  // with higher priority first. This helps the resolver a lot because if some
  // package has a higher weight to the solution (like a direct dependency) or
  // is more likely to break our solution in the future than others, it would be
  // great to try out and evaluate all versions early in the decision tree.
  var resolutionPriority = {};

  // put direct dependencies on higher priority
  dependencies.each(function (dep) {
    resolutionPriority[dep] = 100;
  });

  var someError = null;
  var solution = null;
  while (! pq.empty()) {
    // Since we're in a CPU-bound loop, allow yielding or printing a message or
    // something.
    self._nudge && self._nudge();

    var currentState = pq.pop();

    if (currentState.dependencies.isEmpty()) {
      solution = currentState.choices;
      break;
    }

    var neighborsObj = self._stateNeighbors(currentState, resolutionPriority);

    if (! neighborsObj.success) {
      someError = someError || neighborsObj.failureMsg;
      resolutionPriority[neighborsObj.conflictingUnit] = (resolutionPriority[neighborsObj.conflictingUnit] || 0) + 1;
    } else {
      _.each(neighborsObj.neighbors, function (state) {
        var tentativeCost =
          combineCostFunction(costFunction(state),
                              estimateCostFunction(state));

        pq.push(state, [tentativeCost, -mori.count(state.choices)]);
      });
    }
  }

  if (solution)
    return solution;

  // XXX should be much much better
  if (someError) {
    var e = new Error(someError);
    e.constraintSolverError = true;
    throw e;
  }

  throw new Error("Couldn't resolve, I am sorry");
};

// state is an object:
// - dependencies: DependenciesList - remaining dependencies
// - constraints: ConstraintsList - constraints to satisfy
// - choices: mori.hash_map unitName _> UnitVersion - current set of choices
// - constraintAncestor: Constraint (string representation) ->
//   mori.list(Dependency name). Used for error reporting to indicate which
//   direct dependencies have caused a failure. For every constraint, this is
//   the list of direct dependencies which led to this constraint being present.
//
// returns {
//   success: Boolean,
//   failureMsg: String,
//   neighbors: [state]
// }
//
// NOTE: assumes that exact dependencies are already propagated
ConstraintSolver.Resolver.prototype._stateNeighbors = function (
    state, resolutionPriority) {
  var self = this;

  var dependencies = state.dependencies;
  var constraints = state.constraints;
  var choices = state.choices;
  var constraintAncestor = state.constraintAncestor;

  var candidateName = dependencies.peek();
  var currentNaughtiness = resolutionPriority[candidateName] || 0;

  dependencies.each(function (d) {
    // Prefer to resolve things where there is no choice first (at the very
    // least this includes local packages).
    // XXX should we do this in _propagateExactTransDeps too?
    if (_.size(self.unitsVersions[d]) === 1) {
      candidateName = d;
      return BREAK;
    }
    var r = resolutionPriority[d] || 0;
    if (r > currentNaughtiness) {
      currentNaughtiness = r;
      candidateName = d;
    }
  });

  var edgeVersions = constraints.edgeMatchingVersionsFor(candidateName, self);

  edgeVersions.earliest = edgeVersions.earliest || { version: "1000.1000.1000" };
  edgeVersions.latest = edgeVersions.latest || { version: "0.0.0" };

  if (_.has(self._noUnitVersionsExist, candidateName)) {
    return {
      success: false,
      failureMsg: "No such package: " + candidateName,
      conflictingUnit: candidateName
    };
  }

  var candidateVersions =
    _.filter(self.unitsVersions[candidateName], function (uv) {
       // reject immideately if not in acceptable range
      return semver.lte(edgeVersions.earliest.version, uv.version) && semver.lte(uv.version, edgeVersions.latest.version);
    });

  var generateError = function (name, constraints) {
    var violatedConstraints = constraints.constraintsForPackage(name);

    var directDepsString = "";

    _.each(violatedConstraints, function (c) {
      if (directDepsString !== "")
        directDepsString += ", ";
      var cAsString = c.toString();

      directDepsString += mori.into_array(mori.get(constraintAncestor, c))
        .reverse().join("=>");
      directDepsString += "(" + c.toString() + ")";
    });

    return {
      success: false,
      // XXX We really want to say "directDep1 depends on X@1.0 and
      // directDep2 depends on X@2.0"
      // XXX Imrove message
      failureMsg: "Direct dependencies of " + directDepsString + " conflict on " + name,
      conflictingUnit: candidateName
    };
  };

  if (_.isEmpty(candidateVersions)) {
    // var uv = self.unitsVersions[candidateName] &&
    //       self.unitsVersions[candidateName][0];

    // if (! uv) {
    //   var violatedConstraints = constraints.constraintsForPackage(candidateName);
    //   return { success: false, failureMsg: "Cannot find anything about package -- " + candidateName, conflictingUnit: candidateName };
    // }

    return generateError(candidateName, constraints);
  }

  var firstError = null;

  var neighbors = _.chain(candidateVersions).map(function (uv) {
    return self._propagateExactTransDeps(
      uv, dependencies, constraints, choices, constraintAncestor);
  }).filter(function (state) {
    var vcfc =
      violatedConstraintsForSomeChoice(state.choices, state.constraints, self);

    if (! vcfc)
      return true;

    if (! firstError) {
      firstError = generateError(vcfc.choice.name, constraints);
    }
    return false;
  }).value();

  if (firstError && ! neighbors.length)
    return firstError;

  // Should never be true as !!firstError === !neighbors.length but still check
  // just in case.
  if (! neighbors.length)
    return { success: false,
             failureMsg: "None of the versions unit produces a sensible result -- "
               + candidateName,
             conflictingUnit: candidateName };

  return { success: true, neighbors: neighbors };
};

// Propagates exact dependencies (which have exact constraints) from
// the given unit version taking into account the existing set of dependencies
// and constraints.
// Assumes that the unit versions graph without passed unit version is already
// propagated (i.e. doesn't try to propagate anything not related to the passed
// unit version).
ConstraintSolver.Resolver.prototype._propagateExactTransDeps = function (
    uv, dependencies, constraints, choices, constraintAncestor) {
  var self = this;

  // XXX representing a queue as an array with push/shift operations is not
  // efficient as Array.shift is O(N). Replace if it becomes a problem.
  var queue = [];
  // Boolean map to avoid adding the same stuff to queue over and over again.
  // Keeps the time complexity the same but can save some memory.
  var hasBeenEnqueued = {};
  // // For keeping track of new choices in this iteration
  // var oldChoice = {};
  // _.each(choices, function (uv) { oldChoice[uv.name] = uv; });

  // Keeps track of the exact constraint that led to a choice
  var exactConstrForChoice = {};

  // 'dependencies' tracks units that we still need to choose a version for,
  // so there is no need to keep anything that we've already chosen.
  mori.each(choices, function (nameAndUv) {
    dependencies = dependencies.remove(mori.first(nameAndUv));
  });

  queue.push(uv);
  hasBeenEnqueued[uv.name] = true;
  while (queue.length > 0) {
    // Since we're in a CPU-bound loop, allow yielding or printing a message or
    // something.
    self._nudge && self._nudge();

    uv = queue[0];
    queue.shift();

    // Choose uv itself.
    choices = mori.assoc(choices, uv.name, uv);

    // It's not longer a dependency we need to satisfy.
    dependencies = dependencies.remove(uv.name);

    // Add the constraints from uv to the list of constraints we are tracking.
    constraints = constraints.union(uv.constraints);

    // Add any dependencies from uv that haven't already been chosen to the list
    // of remaining dependencies.
    uv.dependencies.each(function (dep) {
      if (!mori.has_key(choices, dep)) {
        dependencies = dependencies.push(dep);
      }
    });

    // Which nodes to process now? You'd think it would be
    // immediatelyImpliedVersions, sure. But that's too limited: that only
    // includes things where 'uv' both contains the exact constraint and the
    // dependency. If we already had a dependency but 'uv' adds an exact
    // constraint, or vice versa, we should go there too!
    // XXX Strangely, changing some of these calls between
    //     exactDependenciesIntersection and exactConstraintsIntersection
    //     (eg, changing the last one to exactConstraintsIntersection) has
    //     a big impact on correctness or performance... eg, it totally
    //     breaks the benchmark tests.
    var newExactConstraintsList = uv.dependencies
      .exactConstraintsIntersection(constraints)
      .union(uv.constraints.exactDependenciesIntersection(dependencies));

    newExactConstraintsList.each(function (c) {
      var dep = c.getSatisfyingUnitVersion(self);
      if (! dep)
        throw new Error("No unit version was found for the constraint -- " + c.toString());

      // Enqueue all new exact dependencies.
      if (_.has(hasBeenEnqueued, dep.name))
        return;
      queue.push(dep);
      hasBeenEnqueued[dep.name] = true;
      exactConstrForChoice[dep.name] = c;
    });

    var constr = exactConstrForChoice[uv.name];
    if (! constr) {
      // likely the uv passed to this propagation in a first place
      constraints.forPackage(uv.name, function (c) { constr = c; });
    }
    // for error reporting
    uv.constraints.each(function (c) {
      if (! mori.has_key(constraintAncestor, c)) {
        constraintAncestor = mori.assoc(
          constraintAncestor,
          c,
          mori.cons(uv.name,
                    (constr ? mori.get(constraintAncestor, constr) : null)));
      }
    });
  }

  // // Update the constraintAncestor table
  // _.each(choices, function (uv) {
  //   if (oldChoice[uv.name])
  //     return;

  //   var relevantConstraint = null;
  //   constraints.forPackage(uv.name, function (c) { relevantConstraint = c; });

  //   var rootAnc = null;
  //   if (relevantConstraint) {
  //     rootAnc = constraintAncestor[relevantConstraint.toString()];
  //   } else {
  //     // XXX this probably only works correctly when uv was a root dependency
  //     // w/o a constraint or dependency of one of the root deps.
  //     _.each(choices, function (choice) {
  //       if (rootAnc)
  //         return;

  //       if (choice.dependencies.contains(uv.name))
  //         rootAnc = choice.name;
  //     });

  //     if (! rootAnc)
  //       rootAnc = uv.name;
  //   }

  //   uv.constraints.each(function (c) {
  //     if (! constraintAncestor[c.toString()])
  //       constraintAncestor[c.toString()] = rootAnc;
  //   });
  // });

  return {
    dependencies: dependencies,
    constraints: constraints,
    choices: choices,
    constraintAncestor: constraintAncestor
  };
};

var violatedConstraintsForSomeChoice = function (choices, constraints, resolver) {
  var ret = null;
  mori.each(choices, function (nameAndUv) {
    if (ret)
      return;
    var choice = mori.last(nameAndUv);

    var violatedConstraints = constraints.violatedConstraints(choice, resolver);
    if (! _.isEmpty(violatedConstraints))
      ret = { constraints: violatedConstraints, choice: choice };
  });

  return ret;
};

////////////////////////////////////////////////////////////////////////////////
// UnitVersion
////////////////////////////////////////////////////////////////////////////////

ConstraintSolver.UnitVersion = function (name, unitVersion, ecv) {
  var self = this;

  check(name, String);
  check(unitVersion, String);
  check(ecv, String);
  check(self, ConstraintSolver.UnitVersion);

  self.name = name;
  // Things with different build IDs should represent the same code, so ignore
  // them. (Notably: depending on @=1.3.1 should allow 1.3.1+local!)
  self.version = unitVersion.replace(/\+.*$/, '');
  self.dependencies = new ConstraintSolver.DependenciesList();
  self.constraints = new ConstraintSolver.ConstraintsList();
  // a string in a form of "1.2.0"
  self.earliestCompatibleVersion = ecv;
};

_.extend(ConstraintSolver.UnitVersion.prototype, {
  addDependency: function (name) {
    var self = this;

    check(name, String);
    if (self.dependencies.contains(name)) {
      return;
      // XXX may also throw if it is unexpected
      throw new Error("Dependency already exists -- " + name);
    }
    self.dependencies = self.dependencies.push(name);
  },
  addConstraint: function (constraint) {
    var self = this;

    check(constraint, ConstraintSolver.Constraint);
    if (self.constraints.contains(constraint)) {
      return;
      // XXX may also throw if it is unexpected
      throw new Error("Constraint already exists -- " + constraint.toString());
    }

    self.constraints = self.constraints.push(constraint);
  },

  toString: function () {
    var self = this;
    return self.name + "@" + self.version;
  }
});

////////////////////////////////////////////////////////////////////////////////
// Constraint
////////////////////////////////////////////////////////////////////////////////

// Can be called either:
//    new PackageVersion.Constraint("packageA", "=2.1.0")
// or:
//    new PackageVersion.Constraint("pacakgeA@=2.1.0")
ConstraintSolver.Constraint = function (name, versionString) {
  var self = this;

  if (versionString) {
    _.extend(self,
             PackageVersion.parseVersionConstraint(
               versionString, {allowAtLeast: true}));
    self.name = name;
  } else {
    // borrows the structure from the parseVersionConstraint format:
    // - type - String [compatibl-with|exactly|at-least]
    // - version - String - semver string
    _.extend(self, PackageVersion.parseConstraint(name, {allowAtLeast: true}));
  }
  // See comment in UnitVersion constructor.
  self.version = self.version.replace(/\+.*$/, '');
};

ConstraintSolver.Constraint.prototype.toString = function () {
  var self = this;
  var operator = "";
  if (self.type === "exactly")
    operator = "=";
  if (self.type === "at-least")
    operator = ">=";
  return self.name + "@" + operator + self.version;
};


ConstraintSolver.Constraint.prototype.isSatisfied = function (candidateUV,
                                                              resolver) {
  var self = this;
  check(candidateUV, ConstraintSolver.UnitVersion);

  if (self.type === "exactly")
    return self.version === candidateUV.version;

  // If the candidate version is less than the version named in the constraint,
  // we are not satisfied.
  if (semver.lt(candidateUV.version, self.version))
    return false;

  // If we only care about "at-least" and not backwards-incompatible changes in
  // the middle, then candidateUV is good enough.
  if (self.type === "at-least")
    return true;

  var myECV = resolver.getEarliestCompatibleVersion(self.name, self.version);
  // If the constraint is "@1.2.3" and 1.2.3 doesn't exist, then nothing can
  // match. This is because we don't know the ECV (compatibility class) of
  // 1.2.3!
  if (!myECV)
    return false;

  // To be compatible, the two versions must have the same
  // earliestCompatibleVersion. If the earliestCompatibleVersions haven't been
  // overridden from their default, this means that the two versions have the
  // same major version number.
  return myECV === candidateUV.earliestCompatibleVersion;
};

// Returns any unit version satisfying the constraint in the resolver
ConstraintSolver.Constraint.prototype.getSatisfyingUnitVersion = function (
    resolver) {
  var self = this;

  if (self.type === "exactly") {
    return resolver.getUnitVersion(self.name, self.version);
  }

  // XXX this chooses a random UV, not the earliest or latest. Is that OK?
  return _.find(resolver.unitsVersions[self.name], function (uv) {
    return self.isSatisfied(uv, resolver);
  });
};
