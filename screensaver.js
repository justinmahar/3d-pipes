var speed = 1;
var gridBounds = new THREE.Box3(
  new THREE.Vector3(-10, -10, -10),
  new THREE.Vector3(10, 10, 10)
);
var nodes = {};
function setAt(position, value) {
  nodes["(" + position.x + ", " + position.y + ", " + position.z + ")"] = value;
}
function getAt(position, value) {
  return nodes["(" + position.x + ", " + position.y + ", " + position.z + ")"];
}
function clearGrid() {
  nodes = {};
}

// Shared scratch objects to avoid per-frame allocations.
var TMP_VEC_A = new THREE.Vector3();
var TMP_VEC_B = new THREE.Vector3();
var TMP_QUAT = new THREE.Quaternion();
var UNIT_Y = new THREE.Vector3(0, 1, 0);
var PIPE_DIRECTIONS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

// Shared geometry caches so we don't recreate small, similar meshes over and over.
var ringGeometryCache = {};
var sphereGeometryCache = {};

function getRingGeometry(innerRadius, outerRadius, segments) {
  var key =
    innerRadius.toFixed(4) + ":" + outerRadius.toFixed(4) + ":" + segments;
  if (!ringGeometryCache[key]) {
    var geom = new THREE.RingGeometry(innerRadius, outerRadius, segments);
    // Orient so the ring's normal points along +Y (pipe axis in local space),
    // matching what makeCylinderBetweenPoints expects.
    geom.rotateX(-Math.PI / 2);
    ringGeometryCache[key] = geom;
  }
  return ringGeometryCache[key];
}

function getSphereGeometry(radius, segments) {
  var key = radius.toFixed(4) + ":" + segments;
  if (!sphereGeometryCache[key]) {
    sphereGeometryCache[key] = new THREE.SphereGeometry(
      radius,
      segments,
      segments
    );
  }
  return sphereGeometryCache[key];
}

// Track the last time any pipe successfully laid a new segment.
// Used to detect when the system has effectively stalled.
var lastPipeAdvanceTime = performance.now();

var textures = {};
var Pipe = function(scene, options) {
  var self = this;
  var pipeRadius = 0.2;
  // Per-pipe thickness: by default use global setting, but allow
  // pipeOptions to override (so we can limit how many thick pipes
  // exist in a scene).
  var thicknessEnabled = pipeThicknessEnabled;
  if (typeof options.thicknessOverride === "boolean") {
    thicknessEnabled = options.thicknessOverride;
  }
  var thicknessAmount = pipeThicknessAmount;
  if (!isFinite(thicknessAmount) || thicknessAmount < 0) {
    thicknessAmount = 0;
  } else if (thicknessAmount > 1) {
    thicknessAmount = 1;
  }
  var ballJointRadius = pipeRadius * 1.5;
  var teapotSize = ballJointRadius;

  // How many animation frames new geometry takes to grow in.
  var SEGMENT_GROW_FRAMES = 8;
  var JOINT_GROW_FRAMES = 6;

  self.growingParts = [];
  self.colorMode = options.colorMode || "normal"; // "normal" | "scheme" | "random"
  self.colorScheme = null;
  self.palette = null;
  self.paletteIndex = 0;
  self.stuckDecorated = false;
  self.segments = [];
  if (self.colorMode === "scheme") {
    self.colorScheme = chooseFrom([
      "red",
      "green",
      "blue",
      "purple",
      "yellow",
      "cyan",
    ]);
  }

  self.currentPosition = randomIntegerVector3WithinBox(gridBounds);
  self.positions = [self.currentPosition];
  self.object3d = new THREE.Object3D();
  scene.add(self.object3d);
  if (options.texturePath) {
    self.material = new THREE.MeshLambertMaterial({
      map: textures[options.texturePath],
    });
  } else {
    var color = randomInteger(0, 0xffffff);
    var emissive = new THREE.Color(color).multiplyScalar(0.3);
    self.material = new THREE.MeshPhongMaterial({
      specular: 0xa9fcff,
      color: color,
      emissive: emissive,
      shininess: 100,
    });
  }
  function randomColorInScheme(scheme) {
    var r, g, b;
    if (scheme === "red") {
      r = randomInteger(200, 255);
      g = randomInteger(0, 60);
      b = randomInteger(0, 60);
    } else if (scheme === "green") {
      r = randomInteger(0, 60);
      g = randomInteger(180, 255);
      b = randomInteger(0, 60);
    } else if (scheme === "blue") {
      r = randomInteger(0, 50);
      g = randomInteger(0, 70);
      b = randomInteger(190, 255);
    } else if (scheme === "purple") {
      r = randomInteger(150, 230);
      g = randomInteger(0, 50);
      b = randomInteger(190, 255);
    } else if (scheme === "yellow") {
      r = randomInteger(230, 255);
      g = randomInteger(200, 255);
      b = randomInteger(0, 60);
    } else if (scheme === "cyan") {
      r = randomInteger(0, 60);
      g = randomInteger(190, 255);
      b = randomInteger(190, 255);
    } else {
      // fallback to fully random
      r = randomInteger(0, 255);
      g = randomInteger(0, 255);
      b = randomInteger(0, 255);
    }
    return (r << 16) | (g << 8) | b;
  }

  function buildPalette() {
    if (self.colorMode === "normal") {
      self.palette = null;
      return;
    }
    var palette = [];
    if (self.colorMode === "scheme") {
      // Two algorithmically chosen, high-contrast colors within the same scheme
      // so stripes are obvious but still fully randomized.
      var base = randomColorInScheme(self.colorScheme);
      var alt = randomColorInScheme(self.colorScheme);

      function luminance(color) {
        var r = (color >> 16) & 0xff;
        var g = (color >> 8) & 0xff;
        var b = color & 0xff;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }

      var tries = 0;
      while (tries < 20) {
        var dr = ((base >> 16) & 0xff) - ((alt >> 16) & 0xff);
        var dg = ((base >> 8) & 0xff) - ((alt >> 8) & 0xff);
        var db = (base & 0xff) - (alt & 0xff);
        var distSq = dr * dr + dg * dg + db * db;
        var lumDiff = Math.abs(luminance(base) - luminance(alt));

        // Require both chroma and brightness difference so stripes read clearly.
        if (distSq > 100 * 100 && lumDiff > 40) {
          break;
        }
        alt = randomColorInScheme(self.colorScheme);
        tries++;
      }

      // As a last resort, derive a much lighter or darker variant of base
      // while staying roughly within the same scheme.
      if (tries >= 20) {
        var br = (base >> 16) & 0xff;
        var bg = (base >> 8) & 0xff;
        var bb = base & 0xff;
        var lum = luminance(base);
        var scale = lum < 128 ? 2.2 : 0.35;
        var nr = Math.max(0, Math.min(255, Math.round(br * scale)));
        var ng = Math.max(0, Math.min(255, Math.round(bg * scale)));
        var nb = Math.max(0, Math.min(255, Math.round(bb * scale)));
        alt = (nr << 16) | (ng << 8) | nb;
      }

      palette.push(base, alt);
    } else if (self.colorMode === "random") {
      // 2–10 distinct random colors, cycled for a rainbow-like effect
      var count = randomInteger(2, 10);
      for (var i = 0; i < count; i++) {
        palette.push(randomInteger(0, 0xffffff));
      }
    }
    self.palette = palette;
    self.paletteIndex = 0;
  }

  buildPalette();

  function createPieceMaterial() {
    if (self.colorMode === "normal" || !self.palette || !self.palette.length) {
      return self.material;
    }
    var color = self.palette[self.paletteIndex % self.palette.length];
    self.paletteIndex += 1;
    var emissive = new THREE.Color(color).multiplyScalar(0.3);
    return new THREE.MeshPhongMaterial({
      specular: 0xa9fcff,
      color: color,
      emissive: emissive,
      shininess: 100,
    });
  }
  function scheduleGrow(mesh, type) {
    mesh.userData.growType = type;
    mesh.userData.growProgress = 0;
    if (type === "segment") {
      // Grow along length only; radius stays full size.
      mesh.scale.set(1, 0.01, 1);
      mesh.userData.growFrames = SEGMENT_GROW_FRAMES;
    } else {
      // Joints grow uniformly from a point.
      mesh.scale.set(0.01, 0.01, 0.01);
      mesh.userData.growFrames = JOINT_GROW_FRAMES;
    }
    self.growingParts.push(mesh);
  }
  var makeCylinderBetweenPoints = function(
    fromPoint,
    toPoint,
    material,
    addStartCap
  ) {
    // Compute direction and length using shared scratch vectors/quaternions
    TMP_VEC_A.subVectors(toPoint, fromPoint);
    var length = TMP_VEC_A.length();
    if (length <= 0.0001) {
      return;
    }
    TMP_VEC_A.normalize();
    TMP_QUAT.setFromUnitVectors(UNIT_Y, TMP_VEC_A);
    // Segment counts driven by explicit pipe-sides override, with a sane default.
    var radialSegments = pipeSidesOverride > 0 ? pipeSidesOverride : 14;
    var heightSegments = Math.max(2, Math.round(radialSegments / 3));

    var baseMaterial =
      self.colorMode === "normal" ? material : createPieceMaterial();

    // Simple solid pipe when thickness is disabled: just one cylinder, no caps.
    if (!thicknessEnabled || pipeThicknessAmount <= 0) {
      var solidGeometry = new THREE.CylinderGeometry(
        pipeRadius,
        pipeRadius,
        length,
        radialSegments,
        heightSegments,
        true
      );
      solidGeometry.translate(0, length / 2, 0);
      var solidMesh = new THREE.Mesh(solidGeometry, baseMaterial);
      solidMesh.quaternion.copy(TMP_QUAT);
      solidMesh.position.copy(fromPoint);
      solidMesh.updateMatrix();
      self.object3d.add(solidMesh);
      lastPipeAdvanceTime = performance.now();
      scheduleGrow(solidMesh, "segment");
      return;
    }

    // Hollow tube: outer and inner shells plus optional end caps.
    var outerGeometry = new THREE.CylinderGeometry(
      pipeRadius,
      pipeRadius,
      length,
      radialSegments,
      heightSegments,
      true
    );
    // Move geometry so its base is at y=0 and it extends in +Y.
    outerGeometry.translate(0, length / 2, 0);

    // Inner shell radius derived from configurable thicknessAmount.
    var innerRadius = pipeRadius * (1 - pipeThicknessAmount);
    // Clamp to avoid degenerate cases.
    innerRadius = Math.max(0.01, Math.min(pipeRadius - 0.01, innerRadius));
    var innerGeometry = new THREE.CylinderGeometry(
      innerRadius,
      innerRadius,
      length,
      radialSegments,
      heightSegments,
      true
    );
    innerGeometry.translate(0, length / 2, 0);

    var outerMesh = new THREE.Mesh(outerGeometry, baseMaterial);

    // Inner surface uses back-face rendering so we see the inside of the tube.
    var innerMaterial = baseMaterial.clone();
    innerMaterial.side = THREE.BackSide;
    var innerMesh = new THREE.Mesh(innerGeometry, innerMaterial);

    // Group inner and outer so they grow together as one segment.
    var segmentGroup = new THREE.Object3D();
    segmentGroup.add(outerMesh);
    segmentGroup.add(innerMesh);

    segmentGroup.quaternion.copy(TMP_QUAT);
    // Anchor the base at fromPoint so the segment can grow outward.
    segmentGroup.position.copy(fromPoint);
    segmentGroup.updateMatrix();

    self.object3d.add(segmentGroup);

    // Add flat ring caps at BOTH ends of this hollow segment so that
    // looking down the pipe you see a clean ring, not a gap between
    // inner and outer shells. Caps are children of the segment group,
    // so they move with the pipe as it grows.
    var ringSegments =
      pipeSidesOverride > 0
        ? pipeSidesOverride
        : Math.round(radialSegments * 1.2);
    var ringGeometry = getRingGeometry(innerRadius, pipeRadius, ringSegments);
    // Make the ring's normal point along +Y (pipe axis in local space)
    // so it faces out of the pipe ends when the segment group is rotated.
    ringGeometry.rotateX(-Math.PI / 2);
    var ringMaterial = baseMaterial.clone();
    ringMaterial.side = THREE.DoubleSide;

    var ringStart = null;
    if (addStartCap) {
      // Near-end cap (at the base of the segment), only when we changed direction
      ringStart = new THREE.Mesh(ringGeometry, ringMaterial);
      ringStart.position.set(0, -0.001, 0);
      segmentGroup.add(ringStart);
    }

    // Far-end cap (at the tip of the segment) for the current head
    var ringEnd = new THREE.Mesh(ringGeometry, ringMaterial.clone());
    ringEnd.position.set(0, length + 0.001, 0);
    segmentGroup.add(ringEnd);

    segmentGroup.userData.startCap = ringStart;
    segmentGroup.userData.endCap = ringEnd;

    // Track segments so we can disable caps on older ones (keep caps only
    // for the current head segment and the one before it).
    self.segments.push(segmentGroup);
    if (self.segments.length > 2) {
      for (var si = 0; si < self.segments.length - 2; si++) {
        var seg = self.segments[si];
        if (!seg || !seg.userData) continue;
        if (seg.userData.startCap) {
          if (seg.userData.startCap.parent) {
            seg.userData.startCap.parent.remove(seg.userData.startCap);
          }
          // Geometry is shared from cache; don't dispose it.
          if (seg.userData.startCap.material) {
            seg.userData.startCap.material.dispose();
          }
          seg.userData.startCap = null;
        }
        if (seg.userData.endCap) {
          if (seg.userData.endCap.parent) {
            seg.userData.endCap.parent.remove(seg.userData.endCap);
          }
          // Geometry is shared from cache; don't dispose it.
          if (seg.userData.endCap.material) {
            seg.userData.endCap.material.dispose();
          }
          seg.userData.endCap = null;
        }
      }
      // Additionally, if we did NOT change direction for this new head
      // segment, remove the end cap from the immediate previous segment,
      // since a straight run doesn't need a visible boundary ring.
      if (!addStartCap && self.segments.length >= 2) {
        var prevSeg = self.segments[self.segments.length - 2];
        if (prevSeg && prevSeg.userData && prevSeg.userData.endCap) {
          if (prevSeg.userData.endCap.parent) {
            prevSeg.userData.endCap.parent.remove(prevSeg.userData.endCap);
          }
          // Geometry is shared from cache; don't dispose it.
          if (prevSeg.userData.endCap.material) {
            prevSeg.userData.endCap.material.dispose();
          }
          prevSeg.userData.endCap = null;
        }
      }
    }

    // Mark time whenever a new segment is successfully laid.
    lastPipeAdvanceTime = performance.now();
    scheduleGrow(segmentGroup, "segment");
  };
  var makeBallJoint = function(position) {
    var segments = jointSegmentsOverride > 0 ? jointSegmentsOverride : 12;
    var ball = new THREE.Mesh(
      // Segment counts depend on geometry quality
      getSphereGeometry(ballJointRadius, segments),
      createPieceMaterial()
    );
    ball.position.copy(position);
    self.object3d.add(ball);
    scheduleGrow(ball, "joint");
  };
  var makeTeapotJoint = function(position) {
    //var teapotTexture = textures[options.texturePath].clone();
    //teapotTexture.repeat.set(1, 1);

    // THREE.TeapotBufferGeometry = function ( size, segments, bottom, lid, body, fitLid, blinn )
    var teapot = new THREE.Mesh(
      new THREE.TeapotBufferGeometry(teapotSize, true, true, true, true, true),
      createPieceMaterial()
      //new THREE.MeshLambertMaterial({ map: teapotTexture })
    );
    teapot.position.copy(position);
    teapot.rotation.x = (Math.floor(random(0, 50)) * Math.PI) / 2;
    teapot.rotation.y = (Math.floor(random(0, 50)) * Math.PI) / 2;
    teapot.rotation.z = (Math.floor(random(0, 50)) * Math.PI) / 2;
    self.object3d.add(teapot);
    scheduleGrow(teapot, "joint");
  };
  var makeElbowJoint = function(fromPosition, toPosition, tangentVector) {
    // elbow
    // var r = 0.2;
    // elbow = new THREE.Mesh(
    //   new THREE.TorusGeometry(r, pipeRadius, 8, 8, Math.PI / 2),
    //   self.material
    // );
    // elbow.position.copy(fromPosition);
    // self.object3d.add(elbow);

    // "elball" (not a proper elbow)
    var segments = jointSegmentsOverride > 0 ? jointSegmentsOverride : 12;
    var elball = new THREE.Mesh(
      // Match ball joint smoothness / performance
      getSphereGeometry(pipeRadius, segments),
      createPieceMaterial()
    );
    elball.position.copy(fromPosition);
    self.object3d.add(elball);
    scheduleGrow(elball, "joint");

    // extrude an elbow joint

    // there's THREE.EllipseCurve... but that's 2D

    // function ArcCurve(scale) {
    //   THREE.Curve.call(this);
    //   this.scale = scale === undefined ? 1 : scale; // TODO: remove me probably
    // }

    // ArcCurve.prototype = Object.create(THREE.Curve.prototype);
    // ArcCurve.prototype.constructor = ArcCurve;

    // ArcCurve.prototype.getPoint = function(t) {
    //   function circ(t) {
    //     return Math.sqrt(1 - t * t);
    //   }

    //   var tx = t;
    //   var ty = circ(t);
    //   var tz = 0;

    //   return new THREE.Vector3(tx, ty, tz).multiplyScalar(this.scale);
    // };

    // var extrudePath = new ArcCurve(0.1);

    // var extrudePath = new THREE.CatmullRomCurve3([fromPosition, toPosition], false); // not enough to define the curve

    // var extrusionSegments = 100;
    // var radiusSegments = 10;
    // var radius = pipeRadius;
    // var tubeGeometry = new THREE.TubeBufferGeometry(
    //   extrudePath,
    //   extrusionSegments,
    //   radius,
    //   radiusSegments,
    //   false
    // );

    // var elbow = new THREE.Mesh(tubeGeometry, self.material);
    // elbow.position.copy(toPosition);
    // self.object3d.add(elbow);
  };

  // if (getAt(self.currentPosition)) {
  //   return; // TODO: find a position that's free
  // }
  setAt(self.currentPosition, self);

  makeBallJoint(self.currentPosition);

  self.update = function() {
    // Animate any newly added meshes growing in.
    // While anything is still growing, we hold off on creating new segments
    // so the pipe appears to grow smoothly, one piece at a time.
    if (self.growingParts.length > 0) {
      var stillGrowing = false;
      for (var i = self.growingParts.length - 1; i >= 0; i--) {
        var mesh = self.growingParts[i];
        mesh.userData.growProgress += 1;
        var t = mesh.userData.growProgress / mesh.userData.growFrames;
        if (t >= 1) {
          mesh.scale.set(1, 1, 1);
          self.growingParts.splice(i, 1);
        } else {
          // ease-out growth
          var eased = 1 - Math.pow(1 - t, 2);
          if (mesh.userData.growType === "segment") {
            var sy = 0.01 + (1 - 0.01) * eased;
            mesh.scale.y = sy;
          } else {
            var s = 0.01 + (1 - 0.01) * eased;
            mesh.scale.set(s, s, s);
          }
          stillGrowing = true;
        }
      }
      if (stillGrowing) {
        return;
      }
    }
    var lastDirectionVector = null;
    if (self.positions.length > 1) {
      var lastPosition = self.positions[self.positions.length - 2];
      // Reuse TMP_VEC_B for last direction (current - previous).
      TMP_VEC_B.subVectors(self.currentPosition, lastPosition);
      lastDirectionVector = TMP_VEC_B;
    }

    // Choose a primary direction, preferring to continue straight when possible.
    var primaryDirection = null;
    if (lastDirectionVector && chance(1 / 2)) {
      // Map lastDirectionVector to one of the canonical PIPE_DIRECTIONS.
      for (var li = 0; li < PIPE_DIRECTIONS.length; li++) {
        if (PIPE_DIRECTIONS[li].equals(lastDirectionVector)) {
          primaryDirection = PIPE_DIRECTIONS[li];
          break;
        }
      }
      // Fallback if it somehow didn't match exactly.
      if (!primaryDirection) {
        primaryDirection = PIPE_DIRECTIONS[0];
      }
    } else {
      primaryDirection = PIPE_DIRECTIONS[chooseFrom([0, 1, 2, 3, 4, 5])];
    }

    // Build a prioritized list of directions: primary first, then the rest shuffled.
    var prioritizedDirections = [];
    // Find a matching entry in allDirections for primaryDirection
    var primaryMatched = null;
    for (var d = 0; d < PIPE_DIRECTIONS.length; d++) {
      if (PIPE_DIRECTIONS[d].equals(primaryDirection)) {
        primaryMatched = PIPE_DIRECTIONS[d];
        break;
      }
    }
    if (primaryMatched) {
      prioritizedDirections.push(primaryMatched);
    }
    // Add the remaining directions in random order
    var remaining = PIPE_DIRECTIONS.filter(function(dir) {
      return !primaryMatched || !dir.equals(primaryMatched);
    });
    shuffleArrayInPlace(remaining);
    Array.prototype.push.apply(prioritizedDirections, remaining);

    // Try each direction at most once until we find a free, in-bounds cell.
    var directionVector = null;
    for (var i = 0; i < prioritizedDirections.length; i++) {
      var dir = prioritizedDirections[i];
      // Use shared TMP_VEC_A for candidate position.
      TMP_VEC_A.addVectors(self.currentPosition, dir);
      if (!gridBounds.containsPoint(TMP_VEC_A)) {
        continue;
      }
      if (getAt(TMP_VEC_A)) {
        continue;
      }
      directionVector = dir;
      break;
    }

    // If all 6 directions are blocked or out of bounds, this pipe is stuck.
    if (!directionVector) {
      if (!self.stuckDecorated) {
        // console.log(
        //   "Pipe stuck: all 6 directions blocked or out of bounds at",
        //   self.currentPosition.x,
        //   self.currentPosition.y,
        //   self.currentPosition.z
        // );
        // Add a final joint at the pipe end once: prefer teapot, otherwise ball.
        if (chance(options.teapotChance)) {
          makeTeapotJoint(self.currentPosition);
        } else {
          makeBallJoint(self.currentPosition);
        }
        self.stuckDecorated = true;
      }
      return;
    }

    // Compute newPosition once from the chosen direction.
    var newPosition = self.currentPosition.clone().add(directionVector);
    setAt(newPosition, self);

    // joint
    // (initial ball joint is handled elsewhere)
    if (lastDirectionVector && !lastDirectionVector.equals(directionVector)) {
      if (chance(options.teapotChance)) {
        makeTeapotJoint(self.currentPosition);
      } else if (chance(options.ballJointChance)) {
        makeBallJoint(self.currentPosition);
      } else {
        makeElbowJoint(self.currentPosition, newPosition, lastDirectionVector);
      }
    }

    // pipe
    var changedDirection =
      lastDirectionVector && !lastDirectionVector.equals(directionVector);
    makeCylinderBetweenPoints(
      self.currentPosition,
      newPosition,
      self.material,
      changedDirection
    );

    // update
    self.currentPosition = newPosition;
    self.positions.push(newPosition);

    // var extrudePath = new THREE.CatmullRomCurve3(self.positions, false, "catmullrom");

    // var extrusionSegments = 10 * self.positions.length;
    // var radiusSegments = 10;
    // var tubeGeometry = new THREE.TubeBufferGeometry( extrudePath, extrusionSegments, pipeRadius, radiusSegments, false );

    // if(self.mesh){
    // 	self.object3d.remove(self.mesh);
    // }
    // self.mesh = new THREE.Mesh(tubeGeometry, self.material);
    // self.object3d.add(self.mesh);
  };
};

var JOINTS_ELBOW = "elbow";
var JOINTS_BALL = "ball";
var JOINTS_MIXED = "mixed";
var JOINTS_CYCLE = "cycle";

var jointsCycleArray = [JOINTS_ELBOW, JOINTS_BALL, JOINTS_MIXED];
var jointsCycleIndex = 0;

var jointTypeSelect = document.getElementById("joint-types");

var pipes = [];
var paused = false;
var options = {
  multiple: true,
  texturePath: null,
  joints: jointTypeSelect.value,
  interval: [16, 24], // range of seconds between fade-outs... not necessarily anything like how the original works
  baseTeapotChance: 1 / 1000,
  candyCanePipeChance: 1 / 200,
  candyCaneTeapotChance: 1 / 500,
  // multicolor pipes: at most one multicolor pipe per set of pipes
  multiColorEnabled: false,
  multiColorSchemePipeChance: 1 / 1000,
  multiColorRandomPipeChance: 1 / 500,
  transitionDuration: 1.2,
  transitionDelay: 0,
  fadeCurve: 1,
  fadeStretch: 1,
  useFastManualTransitions: true,
  transitionType: "dissolve", // "dissolve" or "fade"
  initialVanillaScenes: 5,
  sceneIndex: 0,
  fpsCutoffEnabled: false,
  fpsCutoffValue: 20,
  idleCutoffSeconds: 2,
  // Snow
  snowEnabled: true,
  snowDensity: 400,
  snowSpeed: 1,
  snowFadeDuration: 0.6,
  isCandyScene: false,
  cutoffGraceSeconds: 3,
  thicknessEnabled: true,
  thicknessAmount: 0.3,
  maxThickPipesPerScene: 3,
};
jointTypeSelect.addEventListener("change", function() {
  options.joints = jointTypeSelect.value;
});

// Quality controls
var resolutionScale = "retina"; // "normal" | "retina"
var pipeThicknessEnabled = true;
var pipeThicknessAmount = 0.3;
var pipeThicknessMax = 3;
var pipeSidesOverride = 0;
var jointSegmentsOverride = 0;
var maxPipesPerScene = 0;

var resolutionScaleSelect = document.getElementById("resolution-scale");
if (resolutionScaleSelect) {
  resolutionScale = resolutionScaleSelect.value || resolutionScale;
  resolutionScaleSelect.addEventListener("change", function() {
    resolutionScale = resolutionScaleSelect.value || resolutionScale;
    applyRendererSettings();
  });
}

var pipeThicknessEnabledInput = document.getElementById(
  "pipe-thickness-enabled"
);
var pipeThicknessAmountInput = document.getElementById("pipe-thickness-amount");
var pipeThicknessMaxInput = document.getElementById("pipe-thickness-max");
var pipeSidesInput = document.getElementById("pipe-sides");
var jointSegmentsInput = document.getElementById("joint-segments");
var maxPipesPerSceneInput = document.getElementById("max-pipes-per-scene");

function updatePipeThicknessFromUI() {
  if (pipeThicknessEnabledInput) {
    pipeThicknessEnabled = !!pipeThicknessEnabledInput.checked;
    options.thicknessEnabled = pipeThicknessEnabled;
  }
  if (pipeThicknessAmountInput) {
    var v = parseFloat(pipeThicknessAmountInput.value);
    if (!isFinite(v) || v < 0) v = 0;
    if (v > 1) v = 1;
    pipeThicknessAmount = v;
    options.thicknessAmount = v;
    // Disable numeric input when thickness is off
    pipeThicknessAmountInput.disabled = !pipeThicknessEnabled;
  }
  if (pipeThicknessMaxInput) {
    var m = parseInt(pipeThicknessMaxInput.value, 10);
    if (!isFinite(m) || m < 0) m = 0;
    pipeThicknessMax = m;
    options.maxThickPipesPerScene = m;
  }
}

if (
  pipeThicknessEnabledInput ||
  pipeThicknessAmountInput ||
  pipeThicknessMaxInput
) {
  updatePipeThicknessFromUI();
  if (pipeThicknessEnabledInput) {
    pipeThicknessEnabledInput.addEventListener(
      "change",
      updatePipeThicknessFromUI
    );
  }
  if (pipeThicknessAmountInput) {
    pipeThicknessAmountInput.addEventListener(
      "change",
      updatePipeThicknessFromUI
    );
  }
  if (pipeThicknessMaxInput) {
    pipeThicknessMaxInput.addEventListener("change", updatePipeThicknessFromUI);
  }
}

function updateGeometryGranularFromUI() {
  if (pipeSidesInput) {
    var ps = parseInt(pipeSidesInput.value, 10);
    if (!isFinite(ps) || ps < 0) ps = 0;
    if (ps > 64) ps = 64;
    pipeSidesOverride = ps;
  }
  if (jointSegmentsInput) {
    var js = parseInt(jointSegmentsInput.value, 10);
    if (!isFinite(js) || js < 0) js = 0;
    if (js > 64) js = 64;
    jointSegmentsOverride = js;
  }
  if (maxPipesPerSceneInput) {
    var mp = parseInt(maxPipesPerSceneInput.value, 10);
    if (!isFinite(mp) || mp < 0) mp = 0;
    maxPipesPerScene = mp;
  }
}

if (pipeSidesInput || jointSegmentsInput || maxPipesPerSceneInput) {
  updateGeometryGranularFromUI();
  if (pipeSidesInput) {
    pipeSidesInput.addEventListener("change", updateGeometryGranularFromUI);
  }
  if (jointSegmentsInput) {
    jointSegmentsInput.addEventListener("change", updateGeometryGranularFromUI);
  }
  if (maxPipesPerSceneInput) {
    maxPipesPerSceneInput.addEventListener(
      "change",
      updateGeometryGranularFromUI
    );
  }
}

// Speed control elements
var speedInputEl = document.querySelector('input[name="speed"]');
var speedDisplayEl = document.getElementById("speed-display");

function updateSpeedDisplay() {
  if (!speedInputEl || !speedDisplayEl) return;
  var raw = parseInt(speedInputEl.value, 10) || 1;
  var steps = Math.max(1, Math.round(raw / 10));
  speedDisplayEl.textContent = raw + " (" + steps + "x)";
}

if (speedInputEl) {
  speedInputEl.addEventListener("input", updateSpeedDisplay);
}

// Teapot / candycane / multicolor controls
var baseTeapotInput = document.getElementById("base-teapot-denom");
var candycanePipeInput = document.getElementById("candycane-pipe-denom");
var candycaneTeapotInput = document.getElementById("candycane-teapot-denom");
var multiColorEnabledInput = document.getElementById("multicolor-enabled");
var multiColorSchemeInput = document.getElementById("multicolor-scheme-denom");
var multiColorRandomInput = document.getElementById("multicolor-random-denom");
var dissolveTileSizeInput = document.getElementById("dissolve-tile-size");
var dissolveTileSizeDisplay = document.getElementById(
  "dissolve-tile-size-display"
);
var transitionDurationInput = document.getElementById("transition-duration");
var transitionDurationDisplay = document.getElementById(
  "transition-duration-display"
);
var transitionDelayInput = document.getElementById("transition-delay");
var transitionDelayDisplay = document.getElementById(
  "transition-delay-display"
);
var fadeCurveInput = document.getElementById("fade-curve");
var fadeCurveDisplay = document.getElementById("fade-curve-display");
var fadeStretchInput = document.getElementById("fade-stretch");
var fadeStretchDisplay = document.getElementById("fade-stretch-display");
var initialVanillaScenesInput = document.getElementById(
  "initial-vanilla-scenes"
);
var transitionTypeRadios = document.querySelectorAll(
  'input[name="transition-type"]'
);
var showFPSInput = document.getElementById("show-fps");
var fpsDisplayEl = document.getElementById("fps-display");
var fastManualInput = document.getElementById("fast-manual-transitions");
var fpsCutoffEnabledInput = document.getElementById("fps-cutoff-enabled");
var fpsCutoffValueInput = document.getElementById("fps-cutoff-value");
var idleCutoffSecondsInput = document.getElementById("idle-cutoff-seconds");
var cutoffGraceSecondsInput = document.getElementById("cutoff-grace-seconds");
var snowEnabledInput = document.getElementById("snow-enabled");
var snowDensityInput = document.getElementById("snow-density");
var snowSpeedInput = document.getElementById("snow-speed");
var snowFadeDurationInput = document.getElementById("snow-fade-duration");

function updateTeapotChancesFromUI() {
  function denomToChance(inputEl, fallback) {
    if (!inputEl) return fallback;
    var v = parseInt(inputEl.value, 10);
    if (!isFinite(v) || v <= 0) return fallback;
    return 1 / v;
  }
  options.baseTeapotChance = denomToChance(
    baseTeapotInput,
    options.baseTeapotChance
  );
  options.candyCanePipeChance = denomToChance(
    candycanePipeInput,
    options.candyCanePipeChance
  );
  options.candyCaneTeapotChance = denomToChance(
    candycaneTeapotInput,
    options.candyCaneTeapotChance
  );
  options.multiColorSchemePipeChance = denomToChance(
    multiColorSchemeInput,
    options.multiColorSchemePipeChance
  );
  options.multiColorRandomPipeChance = denomToChance(
    multiColorRandomInput,
    options.multiColorRandomPipeChance
  );
  if (multiColorEnabledInput) {
    options.multiColorEnabled = !!multiColorEnabledInput.checked;
  }
}

if (baseTeapotInput) {
  baseTeapotInput.addEventListener("change", updateTeapotChancesFromUI);
}
if (candycanePipeInput) {
  candycanePipeInput.addEventListener("change", updateTeapotChancesFromUI);
}
if (candycaneTeapotInput) {
  candycaneTeapotInput.addEventListener("change", updateTeapotChancesFromUI);
}
if (multiColorSchemeInput) {
  multiColorSchemeInput.addEventListener("change", updateTeapotChancesFromUI);
}
if (multiColorRandomInput) {
  multiColorRandomInput.addEventListener("change", updateTeapotChancesFromUI);
}
if (multiColorEnabledInput) {
  multiColorEnabledInput.addEventListener("change", updateTeapotChancesFromUI);
}

function updateDissolveTileSizeFromUI() {
  if (!dissolveTileSizeInput) return;
  var v = parseInt(dissolveTileSizeInput.value, 10);
  if (!isFinite(v) || v <= 0) {
    v = 8;
  }
  dissolveTileSize = v;
  if (dissolveTileSizeDisplay) {
    var label;
    if (v <= 4) {
      label = "super fine";
    } else if (v <= 12) {
      label = "fine";
    } else if (v <= 24) {
      label = "medium";
    } else {
      label = "chunky";
    }
    dissolveTileSizeDisplay.textContent = v + "px (" + label + ")";
  }
}

if (dissolveTileSizeInput) {
  dissolveTileSizeInput.addEventListener("input", updateDissolveTileSizeFromUI);
}

function updateTransitionDurationFromUI() {
  if (!transitionDurationInput) return;
  var v = parseFloat(transitionDurationInput.value);
  if (!isFinite(v) || v <= 0) {
    v = 1.2;
  }
  options.transitionDuration = v;
  if (transitionDurationDisplay) {
    var label;
    if (v <= 0.4) {
      label = "very fast";
    } else if (v <= 0.8) {
      label = "fast";
    } else if (v <= 1.5) {
      label = "normal";
    } else if (v <= 2.5) {
      label = "slow";
    } else {
      label = "very slow";
    }
    transitionDurationDisplay.textContent = v.toFixed(1) + "s (" + label + ")";
  }
}

if (transitionDurationInput) {
  transitionDurationInput.addEventListener(
    "input",
    updateTransitionDurationFromUI
  );
}

function updateTransitionDelayFromUI() {
  if (!transitionDelayInput) return;
  var v = parseFloat(transitionDelayInput.value);
  if (!isFinite(v) || v < 0) {
    v = 0;
  }
  options.transitionDelay = v;
  if (transitionDelayDisplay) {
    transitionDelayDisplay.textContent = v.toFixed(1) + "s";
  }
}

if (transitionDelayInput) {
  transitionDelayInput.addEventListener("input", updateTransitionDelayFromUI);
}

function updateFadeCurveFromUI() {
  if (!fadeCurveInput) return;
  var v = parseFloat(fadeCurveInput.value);
  if (!isFinite(v) || v <= 0) {
    v = 1;
  }
  options.fadeCurve = v;
  if (fadeCurveDisplay) {
    var label;
    if (v < 0.8) {
      label = "aggressive (fades fast)";
    } else if (v < 1.2) {
      label = "linear";
    } else if (v < 2) {
      label = "gentle (slower fade)";
    } else {
      label = "very gentle";
    }
    fadeCurveDisplay.textContent = v.toFixed(1) + " (" + label + ")";
  }
}

if (fadeCurveInput) {
  fadeCurveInput.addEventListener("input", updateFadeCurveFromUI);
}

function updateFadeStretchFromUI() {
  if (!fadeStretchInput) return;
  var v = parseFloat(fadeStretchInput.value);
  if (!isFinite(v) || v <= 0) {
    v = 1;
  }
  options.fadeStretch = v;
  if (fadeStretchDisplay) {
    var label;
    if (v < 1) {
      label = "compressed";
    } else if (v === 1) {
      label = "normal";
    } else if (v <= 2) {
      label = "stretched";
    } else {
      label = "very stretched";
    }
    fadeStretchDisplay.textContent = v.toFixed(1) + "x (" + label + ")";
  }
}

if (fadeStretchInput) {
  fadeStretchInput.addEventListener("input", updateFadeStretchFromUI);
}

function updateInitialVanillaScenesFromUI() {
  if (!initialVanillaScenesInput) return;
  var v = parseInt(initialVanillaScenesInput.value, 10);
  if (!isFinite(v) || v < 0) {
    v = 0;
  }
  options.initialVanillaScenes = v;
}

if (initialVanillaScenesInput) {
  initialVanillaScenesInput.addEventListener(
    "change",
    updateInitialVanillaScenesFromUI
  );
}

if (transitionTypeRadios && transitionTypeRadios.length) {
  transitionTypeRadios.forEach(function(radio) {
    if (radio.checked) {
      options.transitionType = radio.value;
    }
    radio.addEventListener("change", function() {
      if (radio.checked) {
        options.transitionType = radio.value;
      }
    });
  });
}

if (showFPSInput) {
  showFPSInput.addEventListener("change", function() {
    if (!fpsDisplayEl) return;
    if (showFPSInput.checked) {
      // will be updated in the animate loop
      fpsDisplayEl.style.display = "block";
    } else {
      fpsDisplayEl.style.display = "none";
      fpsDisplayEl.textContent = "";
    }
  });
  // initialize visibility
  if (fpsDisplayEl) {
    fpsDisplayEl.style.display = showFPSInput.checked ? "block" : "none";
  }
}

if (fastManualInput) {
  options.useFastManualTransitions = !!fastManualInput.checked;
  fastManualInput.addEventListener("change", function() {
    options.useFastManualTransitions = !!fastManualInput.checked;
  });
}

if (fpsCutoffEnabledInput) {
  options.fpsCutoffEnabled = !!fpsCutoffEnabledInput.checked;
  fpsCutoffEnabledInput.addEventListener("change", function() {
    options.fpsCutoffEnabled = !!fpsCutoffEnabledInput.checked;
  });
}

if (fpsCutoffValueInput) {
  var v = parseInt(fpsCutoffValueInput.value, 10);
  if (isFinite(v) && v > 0) {
    options.fpsCutoffValue = v;
  }
  fpsCutoffValueInput.addEventListener("change", function() {
    var newVal = parseInt(fpsCutoffValueInput.value, 10);
    if (isFinite(newVal) && newVal > 0) {
      options.fpsCutoffValue = newVal;
    }
  });
}

function updateIdleCutoffSecondsFromUI() {
  if (!idleCutoffSecondsInput) return;
  var v = parseFloat(idleCutoffSecondsInput.value);
  if (!isFinite(v) || v < 0) {
    v = 0;
  }
  options.idleCutoffSeconds = v;
}

if (idleCutoffSecondsInput) {
  updateIdleCutoffSecondsFromUI();
  idleCutoffSecondsInput.addEventListener(
    "change",
    updateIdleCutoffSecondsFromUI
  );
}

function updateSnowSettingsFromUI() {
  if (snowEnabledInput) {
    options.snowEnabled = !!snowEnabledInput.checked;
  }
  if (snowDensityInput) {
    var d = parseInt(snowDensityInput.value, 10);
    if (!isFinite(d) || d < 0) {
      d = 0;
    }
    options.snowDensity = d;
  }
  if (snowSpeedInput) {
    var s = parseFloat(snowSpeedInput.value);
    if (!isFinite(s) || s < 0) {
      s = 0;
    }
    options.snowSpeed = s;
  }
  if (snowFadeDurationInput) {
    var f = parseFloat(snowFadeDurationInput.value);
    if (!isFinite(f) || f <= 0) {
      f = 0.6;
    }
    options.snowFadeDuration = f;
  }
}

function updateCutoffGraceFromUI() {
  if (!cutoffGraceSecondsInput) return;
  var g = parseFloat(cutoffGraceSecondsInput.value);
  if (!isFinite(g) || g < 0) {
    g = 0;
  }
  options.cutoffGraceSeconds = g;
}

if (snowEnabledInput || snowDensityInput || snowSpeedInput) {
  // Initialize from UI, but don't rebuild snow geometry yet (scene not created).
  updateSnowSettingsFromUI();
  if (snowEnabledInput) {
    snowEnabledInput.addEventListener("change", function() {
      updateSnowSettingsFromUI();
      rebuildSnowSystem();
    });
  }
  if (snowDensityInput) {
    snowDensityInput.addEventListener("change", function() {
      updateSnowSettingsFromUI();
      rebuildSnowSystem();
    });
  }
  if (snowSpeedInput) {
    snowSpeedInput.addEventListener("change", function() {
      updateSnowSettingsFromUI();
      // Speed affects per-frame motion only; no need to rebuild geometry.
    });
  }
  if (snowFadeDurationInput) {
    snowFadeDurationInput.addEventListener("change", function() {
      updateSnowSettingsFromUI();
    });
  }
}

if (cutoffGraceSecondsInput) {
  updateCutoffGraceFromUI();
  cutoffGraceSecondsInput.addEventListener("change", updateCutoffGraceFromUI);
}

var canvasContainer = document.getElementById("canvas-container");

// 2d canvas for dissolve effect
var canvas2d = document.getElementById("canvas-2d");
var ctx2d = canvas2d.getContext("2d");

// renderer
var canvasWebGL = document.getElementById("canvas-webgl");
var renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  canvas: canvasWebGL,
});

function applyRendererSettings() {
  var pixelRatio =
    resolutionScale === "retina" ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(pixelRatio);
}

applyRendererSettings();
renderer.setSize(window.innerWidth, window.innerHeight);

// camera distance chosen so we're well outside the pipe volume while still filling the viewport
var CAMERA_DISTANCE = 26;

// camera
var camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  1,
  100000
);

// controls
var controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enabled = false;
// controls.autoRotate = true;

// scene
var scene = new THREE.Scene();

// lighting
var ambientLight = new THREE.AmbientLight(0x111111);
scene.add(ambientLight);

var directionalLightL = new THREE.DirectionalLight(0xffffff, 0.9);
directionalLightL.position.set(-1.2, 1.5, 0.5);
scene.add(directionalLightL);

// Snow particles (for candycane scenes)
var snowGeometry = null;
var snowPoints = null;
var snowVelocities = null;
var snowResting = null;
var snowProbe = new THREE.Vector3();
var snowFade = null;
var snowTexture = null;
var snowAreaHalfSize = 14;
var snowYTop = 12;
var snowYBottom = -10;
var lastSnowUpdateTime = performance.now();

function getSnowTexture() {
  if (snowTexture) {
    return snowTexture;
  }
  var size = 64;
  var canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  var ctx = canvas.getContext("2d");
  var center = size / 2;
  var grd = ctx.createRadialGradient(center, center, 0, center, center, center);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  snowTexture = new THREE.Texture(canvas);
  snowTexture.needsUpdate = true;
  return snowTexture;
}

function rebuildSnowSystem() {
  // Clean up any existing snow system.
  if (snowPoints) {
    scene.remove(snowPoints);
    if (snowGeometry) {
      snowGeometry.dispose();
    }
    if (snowPoints.material) {
      snowPoints.material.dispose();
    }
    snowGeometry = null;
    snowPoints = null;
    snowVelocities = null;
    snowResting = null;
    snowFade = null;
  }

  if (!options.snowEnabled) {
    return;
  }

  var count = Math.max(0, Math.min(1500, Math.round(options.snowDensity || 0)));
  if (count <= 0) {
    return;
  }

  snowGeometry = new THREE.BufferGeometry();
  var positions = new Float32Array(count * 3);
  snowVelocities = new Float32Array(count);
  snowResting = new Uint8Array(count); // 0 = falling, 1 = resting
  snowFade = new Float32Array(count); // seconds since landing (for fade-out)
  var colors = new Float32Array(count * 3);

  for (var i = 0; i < count; i++) {
    var idx3 = i * 3;
    positions[idx3] = random(-snowAreaHalfSize, snowAreaHalfSize);
    // Seed flakes throughout the whole snow volume so it doesn't start
    // with a clear gap under the top band.
    positions[idx3 + 1] = random(snowYBottom, snowYTop);
    positions[idx3 + 2] = random(-snowAreaHalfSize, snowAreaHalfSize);
    snowVelocities[i] = random(0.3, 1.0);
    colors[idx3] = 1;
    colors[idx3 + 1] = 1;
    colors[idx3 + 2] = 1;
  }

  snowGeometry.addAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );
  snowGeometry.addAttribute("color", new THREE.BufferAttribute(colors, 3));
  var snowMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.22,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    vertexColors: THREE.VertexColors,
    map: getSnowTexture(),
    alphaTest: 0.1,
  });
  snowPoints = new THREE.Points(snowGeometry, snowMaterial);
  // Render on top of pipes where possible.
  snowPoints.frustumCulled = false;
  snowPoints.renderOrder = 1;
  // Start hidden; visibility is controlled each frame by updateSnow()
  // based on whether we're in an active candycane scene with pipes.
  snowPoints.visible = false;
  scene.add(snowPoints);
}

function updateSnow(dtSeconds) {
  if (!snowPoints || !snowGeometry || dtSeconds <= 0) {
    return;
  }

  var shouldBeVisible =
    options.snowEnabled &&
    options.isCandyScene &&
    !clearing &&
    !paused &&
    pipes.length > 0;
  snowPoints.visible = shouldBeVisible;
  if (!shouldBeVisible) {
    return;
  }

  var positionsAttr = snowGeometry.getAttribute("position");
  var positions = positionsAttr.array;
  var colorsAttr = snowGeometry.getAttribute("color");
  var colors = colorsAttr && colorsAttr.array;
  var count = positions.length / 3;
  var baseSpeed = options.snowSpeed || 0;

  if (baseSpeed <= 0) {
    return;
  }

  for (var i = 0; i < count; i++) {
    var idx3 = i * 3;
    // If this flake is in fade-out mode, gradually dim it and respawn after a delay.
    if (snowResting && snowResting[i] && snowFade && colors) {
      snowFade[i] += dtSeconds;
      var fadeDuration = options.snowFadeDuration || 0.6;
      if (fadeDuration <= 0) {
        fadeDuration = 0.6;
      }
      var t = Math.min(1, snowFade[i] / fadeDuration);
      var b = 1 - t;
      colors[idx3] = b;
      colors[idx3 + 1] = b;
      colors[idx3 + 2] = b;
      if (t >= 1) {
        // Respawn this flake at the top.
        positions[idx3] = random(-snowAreaHalfSize, snowAreaHalfSize);
        positions[idx3 + 1] = snowYTop;
        positions[idx3 + 2] = random(-snowAreaHalfSize, snowAreaHalfSize);
        snowResting[i] = 0;
        snowFade[i] = 0;
        colors[idx3] = 1;
        colors[idx3 + 1] = 1;
        colors[idx3 + 2] = 1;
        continue;
      }
    }

    var vy = snowVelocities[i] * baseSpeed;
    positions[idx3 + 1] -= vy * dtSeconds;

    // Respawn flakes that fall below the snow volume.
    if (positions[idx3 + 1] < snowYBottom) {
      positions[idx3] = random(-snowAreaHalfSize, snowAreaHalfSize);
      positions[idx3 + 1] = snowYTop;
      positions[idx3 + 2] = random(-snowAreaHalfSize, snowAreaHalfSize);
      if (snowResting) {
        snowResting[i] = 0;
      }
      if (snowFade && colors) {
        snowFade[i] = 0;
        colors[idx3] = 1;
        colors[idx3 + 1] = 1;
        colors[idx3 + 2] = 1;
      }
      continue;
    }

    // Coarse collision against the existing pipe occupancy grid.
    if (snowResting) {
      // Probe slightly below the flake to see if we're hitting a pipe node.
      var probeY = positions[idx3 + 1] - 0.25;
      snowProbe.set(
        Math.round(positions[idx3]),
        Math.round(probeY),
        Math.round(positions[idx3 + 2])
      );
      if (getAt(snowProbe)) {
        // Require the flake to be reasonably close horizontally to the pipe node,
        // to avoid "sticking in mid air" when passing near but not over a pipe.
        var dx = positions[idx3] - snowProbe.x;
        var dz = positions[idx3 + 2] - snowProbe.z;
        var distSq = dx * dx + dz * dz;
        var maxDist = 0.6;
        if (distSq <= maxDist * maxDist) {
          // Mark this flake for fade-out (it "hit" a pipe) but let it keep falling.
          if (!snowResting[i]) {
            snowResting[i] = 1;
            if (snowFade) {
              snowFade[i] = 0;
            }
            if (colors) {
              colors[idx3] = 1;
              colors[idx3 + 1] = 1;
              colors[idx3 + 2] = 1;
            }
          }
        }
      }
    }
  }

  positionsAttr.needsUpdate = true;
  if (colorsAttr) {
    colorsAttr.needsUpdate = true;
  }
}

// dissolve transition effect

var dissolveRects = [];
var dissolveRectsIndex = -1;
var dissolveRectsPerRow = 50;
var dissolveRectsPerColumn = 50;
var dissolveTransitionSeconds = 2;
var dissolveTransitionFrames = dissolveTransitionSeconds * 60;
var dissolveEndCallback;
var dissolveStartTime = 0; // ms from performance.now()
// default tile size in pixels; can be overridden from the UI
var dissolveTileSize = 8;
// fade-specific progress (0–frames), -1 when inactive
var fadeFrame = -1;

function dissolve(seconds, endCallback) {
  // TODO: determine rect sizes better and simplify
  // (approximation of squares of a particular size)
  dissolveTransitionSeconds = seconds;
  dissolveTransitionFrames = dissolveTransitionSeconds * 60;
  dissolveEndCallback = endCallback;
  dissolveStartTime = performance.now();

  if (options.transitionType === "fade") {
    // Use fullscreen fade; don't prepare tile list
    dissolveRects = [];
    dissolveRectsIndex = -1;
    fadeFrame = 0;
    return;
  }

  // Tile size is user-configurable via the dissolve granularity slider.
  var targetRectSize = dissolveTileSize || 8; // px
  dissolveRectsPerRow = Math.ceil(window.innerWidth / targetRectSize);
  dissolveRectsPerColumn = Math.ceil(window.innerHeight / targetRectSize);

  dissolveRects = new Array(dissolveRectsPerRow * dissolveRectsPerColumn)
    .fill(null)
    .map(function(_null, index) {
      return {
        x: index % dissolveRectsPerRow,
        y: Math.floor(index / dissolveRectsPerRow),
      };
    });
  shuffleArrayInPlace(dissolveRects);
  dissolveRectsIndex = 0;
}
function finishDissolve() {
  dissolveEndCallback();
  dissolveRects = [];
  dissolveRectsIndex = -1;
  fadeFrame = -1;
  ctx2d.clearRect(0, 0, canvas2d.width, canvas2d.height);
}

var clearing = false;
var clearTID = -1;
var clearDelayTID = -1;
var lastFpsSampleTime = performance.now();
var framesSinceFpsSample = 0;
var sceneStartTime = performance.now();

function beginTransition(fast) {
  if (clearing) {
    return;
  }
  clearing = true;
  // Transition duration comes directly from the configured value,
  // optionally shortened when triggered manually with fast clears.
  var baseDuration = options.transitionDuration || 1.2;
  if (fast && options.useFastManualTransitions) {
    baseDuration *= 0.25;
  }
  var fadeOutTime = Math.max(0.05, baseDuration);
  dissolve(fadeOutTime, reset);
}

function clear(fast) {
  clearTimeout(clearTID);
  clearTimeout(clearDelayTID);
  clearTID = setTimeout(
    clear,
    random(options.interval[0], options.interval[1]) * 1000
  );
  if (!clearing) {
    var delayMs = Math.max(0, (options.transitionDelay || 0) * 1000);
    if (delayMs > 0) {
      clearDelayTID = setTimeout(function() {
        beginTransition(fast);
      }, delayMs);
    } else {
      beginTransition(fast);
    }
  }
}
clearTID = setTimeout(
  clear,
  random(options.interval[0], options.interval[1]) * 1000
);

function reset() {
  renderer.clear();
  for (var i = 0; i < pipes.length; i++) {
    scene.remove(pipes[i].object3d);
  }
  pipes = [];
  clearGrid();
  look();
  // increment scene index after each full clear; used for "intro vanilla" scenes
  options.sceneIndex = (options.sceneIndex || 0) + 1;
  // reset per-scene flags
  options.isCandyScene = false;
  sceneStartTime = performance.now();
  clearing = false;
}

// this function is executed on each animation frame
// Advance the simulation and rendering by one logical step.
function stepOnce() {
  controls.update();
  if (options.texturePath && !textures[options.texturePath]) {
    var texture = THREE.ImageUtils.loadTexture(options.texturePath);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    textures[options.texturePath] = texture;
  }
  // update
  for (var i = 0; i < pipes.length; i++) {
    pipes[i].update(scene);
  }
  if (pipes.length === 0) {
    // Starting a brand new scene of pipes.
    sceneStartTime = performance.now();
    var inIntroVanillaPhase =
      (options.sceneIndex || 0) < (options.initialVanillaScenes || 0);
    var jointType = options.joints;
    if (options.joints === JOINTS_CYCLE) {
      jointType = jointsCycleArray[jointsCycleIndex++];
    }
    var basePipeOptions = {
      // "Normal" pipes teapot rarity; special pipes (candycane, multicolor)
      // can override this to use the special teapot chance instead.
      teapotChance: inIntroVanillaPhase ? 0 : options.baseTeapotChance,
      ballJointChance:
        jointType === JOINTS_BALL ? 1 : jointType === JOINTS_MIXED ? 1 / 3 : 0,
      texturePath: options.texturePath,
    };
    // Chance that this pipe becomes a candy cane pipe (a type of special pipe)
    if (!inIntroVanillaPhase && chance(options.candyCanePipeChance)) {
      // Candy cane pipes: use the special-pipe teapot chance
      basePipeOptions.teapotChance = options.candyCaneTeapotChance;
      basePipeOptions.texturePath = "images/textures/candycane.png";
      options.isCandyScene = true;
      // TODO: DRY
      if (!textures[basePipeOptions.texturePath]) {
        var texture = THREE.ImageUtils.loadTexture(basePipeOptions.texturePath);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(2, 2);
        textures[basePipeOptions.texturePath] = texture;
      }
    }
    // TODO: create new pipes over time?
    var pipeCountBase = 1 + options.multiple * (1 + chance(1 / 10));
    var pipeCount =
      maxPipesPerScene > 0
        ? Math.min(pipeCountBase, maxPipesPerScene)
        : pipeCountBase;
    for (var i = 0; i < pipeCount; i++) {
      var pipeOptions = {
        teapotChance: basePipeOptions.teapotChance,
        ballJointChance: basePipeOptions.ballJointChance,
        texturePath: basePipeOptions.texturePath,
        colorMode: "normal",
      };
      if (!inIntroVanillaPhase && options.multiColorEnabled) {
        if (chance(options.multiColorSchemePipeChance)) {
          pipeOptions.colorMode = "scheme";
        } else if (chance(options.multiColorRandomPipeChance)) {
          pipeOptions.colorMode = "random";
        }
        if (pipeOptions.colorMode !== "normal") {
          // multicolor pipes are also "special pipes":
          // - use special-pipe teapot chance
          // - use solid colors, not textures
          pipeOptions.teapotChance = options.candyCaneTeapotChance;
          pipeOptions.texturePath = null;
        }
      }
      // Limit how many pipes in a scene use hollow/thick geometry.
      var useThicknessForThisPipe =
        pipeThicknessEnabled && i < pipeThicknessMax;
      pipeOptions.thicknessOverride = useThicknessForThisPipe;
      pipes.push(new Pipe(scene, pipeOptions));
    }
  }

  if (!clearing) {
    renderer.render(scene, camera);
  }
}

function updateDissolveLayer() {
  // Fade mode: use fullscreen alpha fade instead of tiles
  if (options.transitionType === "fade") {
    if (fadeFrame < 0 || dissolveTransitionSeconds <= 0) {
      return;
    }
    if (
      canvas2d.width !== window.innerWidth ||
      canvas2d.height !== window.innerHeight
    ) {
      canvas2d.width = window.innerWidth;
      canvas2d.height = window.innerHeight;
    }
    var elapsed = (performance.now() - dissolveStartTime) / 1000;
    var duration =
      dissolveTransitionSeconds > 0 ? dissolveTransitionSeconds : 1;
    var baseLinear = Math.min(1, elapsed / duration);
    var stretch = options.fadeStretch || 1;
    if (stretch <= 0) stretch = 1;
    // Stretch the logical fade curve in time, but cut it off at baseLinear = 1
    var stretchedInput = Math.min(1, baseLinear / stretch);
    var curve = options.fadeCurve || 1;
    if (curve <= 0) curve = 1;
    var t = Math.pow(stretchedInput, curve);
    ctx2d.save();
    ctx2d.fillStyle = "black";
    if (baseLinear >= 1) {
      // At the configured end time, force a fully black frame.
      ctx2d.globalAlpha = 1;
      ctx2d.fillRect(0, 0, canvas2d.width, canvas2d.height);
      ctx2d.restore();
      finishDissolve();
    } else {
      ctx2d.globalAlpha = t;
      ctx2d.fillRect(0, 0, canvas2d.width, canvas2d.height);
      ctx2d.restore();
    }
    return;
  }

  if (
    canvas2d.width !== window.innerWidth ||
    canvas2d.height !== window.innerHeight
  ) {
    canvas2d.width = window.innerWidth;
    canvas2d.height = window.innerHeight;
    // TODO: DRY!
    // actually: TODO: make the 2d canvas really low resolution, and stretch it with CSS, with pixelated interpolation
    if (dissolveRectsIndex > -1) {
      for (var i = 0; i < dissolveRectsIndex; i++) {
        var rect = dissolveRects[i];
        // TODO: could precompute rect in screen space, or at least make this clearer with "xIndex"/"yIndex"
        var rectWidth = innerWidth / dissolveRectsPerRow;
        var rectHeight = innerHeight / dissolveRectsPerColumn;
        ctx2d.fillStyle = "black";
        ctx2d.fillRect(
          Math.floor(rect.x * rectWidth),
          Math.floor(rect.y * rectHeight),
          Math.ceil(rectWidth),
          Math.ceil(rectHeight)
        );
      }
    }
  }
  if (dissolveRectsIndex > -1) {
    // Time-based progression: fill tiles according to elapsed fraction
    var elapsedSeconds = (performance.now() - dissolveStartTime) / 1000;
    var duration2 =
      dissolveTransitionSeconds > 0 ? dissolveTransitionSeconds : 1;
    var baseLinear2 = Math.min(1, elapsedSeconds / duration2);
    var stretch2 = options.fadeStretch || 1;
    if (stretch2 <= 0) stretch2 = 1;
    var stretchedInput2 = Math.min(1, baseLinear2 / stretch2);
    var curve2 = options.fadeCurve || 1;
    if (curve2 <= 0) curve2 = 1;
    var t2 = Math.pow(stretchedInput2, curve2);
    var targetIndex = Math.floor(t2 * dissolveRects.length);
    while (
      dissolveRectsIndex < targetIndex &&
      dissolveRectsIndex < dissolveRects.length
    ) {
      var rect = dissolveRects[dissolveRectsIndex];
      // TODO: could precompute rect in screen space, or at least make this clearer with "xIndex"/"yIndex"
      var rectWidth = innerWidth / dissolveRectsPerRow;
      var rectHeight = innerHeight / dissolveRectsPerColumn;
      ctx2d.fillStyle = "black";
      ctx2d.fillRect(
        Math.floor(rect.x * rectWidth),
        Math.floor(rect.y * rectHeight),
        Math.ceil(rectWidth),
        Math.ceil(rectHeight)
      );
      dissolveRectsIndex += 1;
    }
    if (baseLinear2 >= 1 || dissolveRectsIndex === dissolveRects.length) {
      // At the configured end time, force the whole overlay to black,
      // regardless of how many tiles are individually filled.
      ctx2d.fillStyle = "black";
      ctx2d.fillRect(0, 0, canvas2d.width, canvas2d.height);
      finishDissolve();
    }
  }
}

function animate() {
  var now = performance.now();
  var snowDtSeconds = (now - lastSnowUpdateTime) / 1000;
  if (snowDtSeconds < 0 || snowDtSeconds > 1) {
    snowDtSeconds = 0;
  }
  lastSnowUpdateTime = now;

  var speedValue = speedInputEl ? parseInt(speedInputEl.value, 10) || 1 : 1;

  // Map slider 1–200 to how many simulation steps we run per animation frame.
  // ~10 → 1x, 50 → 5x, 100 → 10x, 200 → 20x.
  var steps = Math.max(1, Math.round(speedValue / 10));

  // keep UI display in sync
  updateSpeedDisplay();

  // FPS display (render loop FPS, not simulation speed) and cutoff
  framesSinceFpsSample += 1;
  var sampleDt = now - lastFpsSampleTime;
  var graceMs = (options.cutoffGraceSeconds || 0) * 1000;
  var sceneElapsedMs = now - sceneStartTime;
  if (sampleDt >= 250) {
    var fps = (framesSinceFpsSample * 1000) / sampleDt;
    // Update on-screen FPS meter
    if (fpsDisplayEl && showFPSInput && showFPSInput.checked) {
      fpsDisplayEl.textContent = fps.toFixed(0) + " FPS";
    }
    // FPS cutoff: if enabled and we're below the threshold, jump to next scene,
    // but only after the grace period so scenes can start cleanly, and never while paused.
    if (
      options.fpsCutoffEnabled &&
      fps < (options.fpsCutoffValue || 0) &&
      !clearing &&
      !paused &&
      sceneElapsedMs >= graceMs
    ) {
      clear(true);
    }
    lastFpsSampleTime = now;
    framesSinceFpsSample = 0;
  }

  // If no pipe has successfully laid a new segment for more than the
  // configured idle cutoff, assume we're stuck and skip to the next scene.
  if (!clearing && !paused && pipes.length > 0 && sceneElapsedMs >= graceMs) {
    var idleMs = (options.idleCutoffSeconds || 0) * 1000;
    if (idleMs > 0) {
      var sinceAdvance = performance.now() - lastPipeAdvanceTime;
      if (sinceAdvance > idleMs) {
        clear(true);
      }
    }
  }

  if (!paused) {
    for (var s = 0; s < steps; s++) {
      stepOnce();
    }
  }

  // Update snow once per render frame, time-based.
  updateSnow(snowDtSeconds);

  // progress dissolve effect once per browser frame, independent of speed
  updateDissolveLayer();

  requestAnimationFrame(animate);
}

function look() {
  // TODO: never don't change the view (except maybe while clearing)
  if (chance(1 / 2)) {
    // head-on view
    camera.position.set(0, 0, CAMERA_DISTANCE);
  } else {
    // random view
    var vector = new THREE.Vector3(CAMERA_DISTANCE, 0, 0);

    var axis = new THREE.Vector3(random(-1, 1), random(-1, 1), random(-1, 1));
    var angle = Math.PI / 2;
    var matrix = new THREE.Matrix4().makeRotationAxis(axis, angle);

    vector.applyMatrix4(matrix);
    // keep the camera at or above the pipes so lighting looks good
    if (vector.y < 0) {
      vector.y = -vector.y;
    }
    camera.position.copy(vector);
  }
  var center = new THREE.Vector3(0, 0, 0);
  camera.lookAt(center);
  // camera.updateProjectionMatrix(); // maybe?
  controls.update();
}
look();

addEventListener(
  "resize",
  function() {
    applyRendererSettings();
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  },
  false
);

canvasContainer.addEventListener("mousedown", function(e) {
  e.preventDefault();
  if (!controls.enabled) {
    if (e.button) {
      clear(true);
    } else {
      look();
    }
  }
  window.getSelection().removeAllRanges();
  document.activeElement.blur();
});

canvasContainer.addEventListener(
  "contextmenu",
  function(e) {
    e.preventDefault();
  },
  false
);

var fullscreenButton = document.getElementById("fullscreen-button");
fullscreenButton.addEventListener(
  "click",
  function(e) {
    if (canvasContainer.requestFullscreen) {
      // W3C API
      canvasContainer.requestFullscreen();
    } else if (canvasContainer.mozRequestFullScreen) {
      // Mozilla current API
      canvasContainer.mozRequestFullScreen();
    } else if (canvasContainer.webkitRequestFullScreen) {
      // Webkit current API
      canvasContainer.webkitRequestFullScreen();
    }
  },
  false
);

// keyboard controls: R to clear, Space to pause/resume
window.addEventListener(
  "keydown",
  function(e) {
    // avoid stealing input focus from form elements
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return;
    }
    if (e.code === "KeyR") {
      e.preventDefault();
      // Restart scene counter so intro vanilla scenes are honored again.
      options.sceneIndex = 0;
      clear(true);
    } else if (e.code === "Space") {
      e.preventDefault();
      paused = !paused;
      if (paused) {
        // While paused, don't allow automatic clears to fire.
        clearTimeout(clearTID);
        clearTimeout(clearDelayTID);
      } else {
        // When resuming, start a fresh timer for the next automatic clear.
        clearTID = setTimeout(
          clear,
          random(options.interval[0], options.interval[1]) * 1000
        );
      }
    }
  },
  false
);

var toggleControlButton = document.getElementById("toggle-controls");
toggleControlButton.addEventListener(
  "click",
  function(e) {
    controls.enabled = !controls.enabled;
    showElementsIf(".normal-controls-enabled", !controls.enabled);
    showElementsIf(".orbit-controls-enabled", controls.enabled);
  },
  false
);

// parse URL parameters
// support e.g. <iframe src="https://1j01.github.io/pipes/#{%22hideUI%22:true}"/>
function updateFromParametersInURL() {
  var paramsJSON = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (paramsJSON) {
    try {
      var params = JSON.parse(paramsJSON);
      if (typeof params !== "object") {
        alert("Invalid URL parameter JSON: top level value must be an object");
        params = null;
      }
    } catch (error) {
      alert(
        "Invalid URL parameter JSON syntax\n\n" +
          error +
          "\n\nRecieved:\n" +
          paramsJSON
      );
    }
  }
  params = params || {};

  // update based on the parameters
  // TODO: support more options
  showElementsIf(".ui-container", !params.hideUI);
}

updateFromParametersInURL();
window.addEventListener("hashchange", updateFromParametersInURL);

// initialize UI displays and start animation
updateSpeedDisplay();
updateTeapotChancesFromUI();
updateDissolveTileSizeFromUI();
updateTransitionDurationFromUI();
updateTransitionDelayFromUI();
updateFadeCurveFromUI();
updateFadeStretchFromUI();
updateInitialVanillaScenesFromUI();
updateIdleCutoffSecondsFromUI();
rebuildSnowSystem();
animate();

/**************\
|boring helpers|
\**************/
function random(x1, x2) {
  return Math.random() * (x2 - x1) + x1;
}
function randomInteger(x1, x2) {
  return Math.round(random(x1, x2));
}
function chance(value) {
  return Math.random() < value;
}
function chooseFrom(values) {
  return values[Math.floor(Math.random() * values.length)];
}
function shuffleArrayInPlace(array) {
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}
function randomIntegerVector3WithinBox(box) {
  return new THREE.Vector3(
    randomInteger(box.min.x, box.max.x),
    randomInteger(box.min.y, box.max.y),
    randomInteger(box.min.z, box.max.z)
  );
}
function showElementsIf(selector, condition) {
  Array.from(document.querySelectorAll(selector)).forEach(function(el) {
    if (condition) {
      el.removeAttribute("hidden");
    } else {
      el.setAttribute("hidden", "hidden");
    }
  });
}
