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

var textures = {};
var Pipe = function(scene, options) {
  var self = this;
  var pipeRadius = 0.2;
  var ballJointRadius = pipeRadius * 1.5;
  var teapotSize = ballJointRadius;

  // How many animation frames new geometry takes to grow in.
  var SEGMENT_GROW_FRAMES = 8;
  var JOINT_GROW_FRAMES = 6;

  self.growingParts = [];

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
  var makeCylinderBetweenPoints = function(fromPoint, toPoint, material) {
    var deltaVector = new THREE.Vector3().subVectors(toPoint, fromPoint);
    var arrow = new THREE.ArrowHelper(
      deltaVector.clone().normalize(),
      fromPoint
    );
    // Segment counts depend on geometry quality
    var radialSegments;
    var heightSegments;
    if (geometryQuality === "low") {
      radialSegments = 8;
      heightSegments = 3;
    } else if (geometryQuality === "medium") {
      radialSegments = 14;
      heightSegments = 6;
    } else {
      radialSegments = 20;
      heightSegments = 8;
    }
    var length = deltaVector.length();
    var geometry = new THREE.CylinderGeometry(
      pipeRadius,
      pipeRadius,
      length,
      radialSegments,
      heightSegments,
      true
    );
    // Move geometry so its base is at y=0 and it extends in +Y.
    geometry.translate(0, length / 2, 0);
    var mesh = new THREE.Mesh(geometry, material);

    mesh.rotation.setFromQuaternion(arrow.quaternion);
    // Anchor the base at fromPoint so the segment can grow outward.
    mesh.position.copy(fromPoint);
    mesh.updateMatrix();

    self.object3d.add(mesh);
    scheduleGrow(mesh, "segment");
  };
  var makeBallJoint = function(position) {
    var ball = new THREE.Mesh(
      // Segment counts depend on geometry quality
      new THREE.SphereGeometry(
        ballJointRadius,
        geometryQuality === "low" ? 8 : geometryQuality === "medium" ? 12 : 16,
        geometryQuality === "low" ? 8 : geometryQuality === "medium" ? 12 : 16
      ),
      self.material
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
      self.material
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
    var elball = new THREE.Mesh(
      // Match ball joint smoothness / performance
      new THREE.SphereGeometry(
        pipeRadius,
        geometryQuality === "low" ? 8 : geometryQuality === "medium" ? 12 : 16,
        geometryQuality === "low" ? 8 : geometryQuality === "medium" ? 12 : 16
      ),
      self.material
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
    if (self.positions.length > 1) {
      var lastPosition = self.positions[self.positions.length - 2];
      var lastDirectionVector = new THREE.Vector3().subVectors(
        self.currentPosition,
        lastPosition
      );
    }
    if (chance(1 / 2) && lastDirectionVector) {
      var directionVector = lastDirectionVector;
    } else {
      var directionVector = new THREE.Vector3();
      directionVector[chooseFrom("xyz")] += chooseFrom([+1, -1]);
    }
    var newPosition = new THREE.Vector3().addVectors(
      self.currentPosition,
      directionVector
    );

    // TODO: try other possibilities
    // ideally, have a pool of the 6 possible directions and try them in random order, removing them from the bag
    // (and if there's truly nowhere to go, maybe make a ball joint)
    if (!gridBounds.containsPoint(newPosition)) {
      return;
    }
    if (getAt(newPosition)) {
      return;
    }
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
    makeCylinderBetweenPoints(self.currentPosition, newPosition, self.material);

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
var options = {
  multiple: true,
  texturePath: null,
  joints: jointTypeSelect.value,
  interval: [16, 24], // range of seconds between fade-outs... not necessarily anything like how the original works
  baseTeapotChance: 1 / 1000,
  candyCanePipeChance: 1 / 200,
  candyCaneTeapotChance: 1 / 500,
  dissolveDuration: 1.2,
};
jointTypeSelect.addEventListener("change", function() {
  options.joints = jointTypeSelect.value;
});

// Quality controls
var geometryQuality = "high"; // "low" | "medium" | "high"
var resolutionScale = "retina"; // "normal" | "retina"

var geometryQualitySelect = document.getElementById("geometry-quality");
if (geometryQualitySelect) {
  geometryQuality = geometryQualitySelect.value || geometryQuality;
  geometryQualitySelect.addEventListener("change", function() {
    geometryQuality = geometryQualitySelect.value || geometryQuality;
  });
}

var resolutionScaleSelect = document.getElementById("resolution-scale");
if (resolutionScaleSelect) {
  resolutionScale = resolutionScaleSelect.value || resolutionScale;
  resolutionScaleSelect.addEventListener("change", function() {
    resolutionScale = resolutionScaleSelect.value || resolutionScale;
    applyRendererSettings();
  });
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

// Teapot / candycane controls
var baseTeapotInput = document.getElementById("base-teapot-denom");
var candycanePipeInput = document.getElementById("candycane-pipe-denom");
var candycaneTeapotInput = document.getElementById("candycane-teapot-denom");
var dissolveTileSizeInput = document.getElementById("dissolve-tile-size");
var dissolveTileSizeDisplay = document.getElementById(
  "dissolve-tile-size-display"
);
var dissolveDurationInput = document.getElementById("dissolve-duration");
var dissolveDurationDisplay = document.getElementById(
  "dissolve-duration-display"
);

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

function updateDissolveDurationFromUI() {
  if (!dissolveDurationInput) return;
  var v = parseFloat(dissolveDurationInput.value);
  if (!isFinite(v) || v <= 0) {
    v = 1.2;
  }
  options.dissolveDuration = v;
  if (dissolveDurationDisplay) {
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
    dissolveDurationDisplay.textContent = v.toFixed(1) + "s (" + label + ")";
  }
}

if (dissolveDurationInput) {
  dissolveDurationInput.addEventListener("input", updateDissolveDurationFromUI);
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

// dissolve transition effect

var dissolveRects = [];
var dissolveRectsIndex = -1;
var dissolveRectsPerRow = 50;
var dissolveRectsPerColumn = 50;
var dissolveTransitionSeconds = 2;
var dissolveTransitionFrames = dissolveTransitionSeconds * 60;
var dissolveEndCallback;
// default tile size in pixels; can be overridden from the UI
var dissolveTileSize = 8;

function dissolve(seconds, endCallback) {
  // TODO: determine rect sizes better and simplify
  // (approximation of squares of a particular size)
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
  dissolveTransitionSeconds = seconds;
  dissolveTransitionFrames = dissolveTransitionSeconds * 60;
  dissolveEndCallback = endCallback;
}
function finishDissolve() {
  dissolveEndCallback();
  dissolveRects = [];
  dissolveRectsIndex = -1;
  ctx2d.clearRect(0, 0, canvas2d.width, canvas2d.height);
}

var clearing = false;
var clearTID = -1;
function clear(fast) {
  clearTimeout(clearTID);
  clearTID = setTimeout(
    clear,
    random(options.interval[0], options.interval[1]) * 1000
  );
  if (!clearing) {
    clearing = true;
    // Slightly faster dissolve overall when triggered as "fast"
    var baseDuration = options.dissolveDuration || 1.2;
    var fadeOutTime = fast ? Math.max(0.05, baseDuration * 0.25) : baseDuration;
    dissolve(fadeOutTime, reset);
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
    var jointType = options.joints;
    if (options.joints === JOINTS_CYCLE) {
      jointType = jointsCycleArray[jointsCycleIndex++];
    }
    var pipeOptions = {
      teapotChance: options.baseTeapotChance,
      ballJointChance:
        jointType === JOINTS_BALL ? 1 : jointType === JOINTS_MIXED ? 1 / 3 : 0,
      texturePath: options.texturePath,
    };
    // Chance that this pipe becomes a candy cane pipe
    if (chance(options.candyCanePipeChance)) {
      // Candy cane pipes: higher teapot chance than normal pipes
      pipeOptions.teapotChance = options.candyCaneTeapotChance;
      pipeOptions.texturePath = "images/textures/candycane.png";
      // TODO: DRY
      if (!textures[pipeOptions.texturePath]) {
        var texture = THREE.ImageUtils.loadTexture(pipeOptions.texturePath);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(2, 2);
        textures[pipeOptions.texturePath] = texture;
      }
    }
    // TODO: create new pipes over time?
    for (var i = 0; i < 1 + options.multiple * (1 + chance(1 / 10)); i++) {
      pipes.push(new Pipe(scene, pipeOptions));
    }
  }

  if (!clearing) {
    renderer.render(scene, camera);
  }
}

function updateDissolveLayer() {
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
    // TODO: calibrate based on time transition is actually taking
    var rectsAtATime = Math.floor(
      dissolveRects.length / dissolveTransitionFrames
    );
    for (
      var i = 0;
      i < rectsAtATime && dissolveRectsIndex < dissolveRects.length;
      i++
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
    if (dissolveRectsIndex === dissolveRects.length) {
      finishDissolve();
    }
  }
}

function animate() {
  var speedValue = speedInputEl ? parseInt(speedInputEl.value, 10) || 1 : 1;

  // Map slider 1–200 to how many simulation steps we run per animation frame.
  // ~10 → 1x, 50 → 5x, 100 → 10x, 200 → 20x.
  var steps = Math.max(1, Math.round(speedValue / 10));

  // keep UI display in sync
  updateSpeedDisplay();

  for (var s = 0; s < steps; s++) {
    stepOnce();
  }

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
updateDissolveDurationFromUI();
updateDissolveTileSizeFromUI();
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
