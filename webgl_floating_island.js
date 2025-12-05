// webgl_floating_island.js
const canvas = document.getElementById('webgl');
const gl = canvas.getContext('webgl');
if (!gl) {
    alert('WebGL not supported');
    throw new Error('WebGL not supported');
}

// Print controls
console.log('CONTROLS:');
console.log('← → : Rotate camera around islands');
console.log('↑ ↓ : Zoom in/out');
console.log('Q/E : Move camera left/right on X axis');
console.log('A/D : Rotate spotlight (changes shadows)');

// Shader programs
const vertexShaderSource = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec3 aColor;
    
    uniform mat4 uModelMatrix;
    uniform mat4 uViewMatrix;
    uniform mat4 uProjectionMatrix;
    uniform mat4 uLightViewMatrix;
    uniform mat4 uLightProjectionMatrix;
    uniform vec3 uLightPosition;
    
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vFragPos;
    varying vec3 vLightPos;
    varying vec4 vLightSpacePos;
    
    void main() {
        vec4 worldPosition = uModelMatrix * vec4(aPosition, 1.0);
        vFragPos = worldPosition.xyz;
        vNormal = mat3(uModelMatrix) * aNormal;
        vColor = aColor;
        vLightPos = uLightPosition;
        
        vLightSpacePos = uLightProjectionMatrix * uLightViewMatrix * worldPosition;
        gl_Position = uProjectionMatrix * uViewMatrix * worldPosition;
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vFragPos;
    varying vec3 vLightPos;
    varying vec4 vLightSpacePos;
    
    uniform sampler2D uShadowMap;
    uniform float uShadowBias;
    
    float calculateShadow(vec4 lightSpacePos, sampler2D shadowMap, float bias) {
        // Perspective divide
        vec3 projCoords = lightSpacePos.xyz / lightSpacePos.w;
        // Transform to [0,1] range
        projCoords = projCoords * 0.5 + 0.5;
        
        if (projCoords.z > 1.0) {
            return 0.0;
        }
        
        float closestDepth = texture2D(shadowMap, projCoords.xy).r;
        float currentDepth = projCoords.z;
        
        // Simple shadow calculation
        float shadow = currentDepth - bias > closestDepth ? 0.5 : 0.0;
        
        // Apply soft shadows with PCF
        vec2 texelSize = 1.0 / vec2(1024.0, 1024.0);
        for(int x = -1; x <= 1; ++x) {
            for(int y = -1; y <= 1; ++y) {
                float pcfDepth = texture2D(shadowMap, projCoords.xy + vec2(x, y) * texelSize).r;
                shadow += currentDepth - bias > pcfDepth ? 0.5 : 0.0;
            }
        }
        shadow /= 9.0;
        
        return shadow;
    }
    
    void main() {
        vec3 normal = normalize(vNormal);
        vec3 lightDir = normalize(vLightPos - vFragPos);
        
        // Ambient
        float ambientStrength = 0.2;
        vec3 ambient = ambientStrength * vColor;
        
        // Diffuse
        float diff = max(dot(normal, lightDir), 0.0);
        vec3 diffuse = diff * vColor;
        
        // Simple specular
        vec3 viewDir = normalize(-vFragPos);
        vec3 reflectDir = reflect(-lightDir, normal);
        float spec = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);
        vec3 specular = 0.3 * spec * vec3(1.0);
        
        // Shadow
        float shadow = calculateShadow(vLightSpacePos, uShadowMap, uShadowBias);
        
        vec3 lighting = ambient + (1.0 - shadow) * (diffuse + specular);
        
        gl_FragColor = vec4(lighting, 1.0);
    }
`;

// Shadow shaders
const shadowVertexShaderSource = `
    attribute vec3 aPosition;
    uniform mat4 uLightViewMatrix;
    uniform mat4 uLightProjectionMatrix;
    uniform mat4 uModelMatrix;
    
    void main() {
        gl_Position = uLightProjectionMatrix * uLightViewMatrix * uModelMatrix * vec4(aPosition, 1.0);
    }
`;

const shadowFragmentShaderSource = `
    precision mediump float;
    
    void main() {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    }
`;

class Shader {
    constructor(gl, vertexSource, fragmentSource) {
        this.gl = gl;
        this.program = this.createProgram(vertexSource, fragmentSource);
        this.uniforms = {};
    }
    
    createShader(source, type) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }
        return shader;
    }
    
    createProgram(vertexSource, fragmentSource) {
        const vertexShader = this.createShader(vertexSource, this.gl.VERTEX_SHADER);
        const fragmentShader = this.createShader(fragmentSource, this.gl.FRAGMENT_SHADER);
        
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);
        
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            console.error('Program linking error:', this.gl.getProgramInfoLog(program));
            return null;
        }
        
        return program;
    }
    
    use() {
        this.gl.useProgram(this.program);
    }
    
    getUniformLocation(name) {
        if (!this.uniforms[name]) {
            this.uniforms[name] = this.gl.getUniformLocation(this.program, name);
        }
        return this.uniforms[name];
    }
}

class Geometry {
    constructor(gl, vertices, indices, normals, colors) {
        this.gl = gl;
        this.vertexCount = indices.length;
        
        // Create buffers
        this.vertexBuffer = gl.createBuffer();
        this.indexBuffer = gl.createBuffer();
        this.normalBuffer = gl.createBuffer();
        this.colorBuffer = gl.createBuffer();
        
        // Upload data
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
    }
    
    draw(shader) {
        const gl = this.gl;
        
        // Position attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        const positionLocation = gl.getAttribLocation(shader.program, 'aPosition');
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
        
        // Normal attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
        const normalLocation = gl.getAttribLocation(shader.program, 'aNormal');
        if (normalLocation >= 0) {
            gl.enableVertexAttribArray(normalLocation);
            gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0);
        }
        
        // Color attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        const colorLocation = gl.getAttribLocation(shader.program, 'aColor');
        if (colorLocation >= 0) {
            gl.enableVertexAttribArray(colorLocation);
            gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, 0, 0);
        }
        
        // Draw
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.drawElements(gl.TRIANGLES, this.vertexCount, gl.UNSIGNED_SHORT, 0);
    }
}

class PyramidIsland {
    constructor(gl, baseSize = 2.0, height = 3.0) {
        this.gl = gl;
        this.baseSize = baseSize;
        this.height = height;
        this.position = [0, 0, 0];
        this.floatOffset = 0;
        this.floatSpeed = 0.5 + Math.random() * 0.5;
        this.floatAmplitude = 0.1;
        this.groundColor = [0.2, 0.6, 0.2]; // Grass green
        this.dirtColor = [0.5, 0.3, 0.1]; // Brown dirt
        
        this.geometry = null; // Will be created in createGeometry()
        this.vegetation = [];
        this.createGeometry(); // Create geometry immediately
    }
    
    createGeometry() {
        const halfBase = this.baseSize / 2;
        
        // Create vertices for an upside down pyramid
        // Bottom face (ground) at y = 0
        // Apex at y = -height
        
        const vertices = [
            // Bottom face vertices (ground)
            -halfBase, 0, -halfBase,  // 0: back-left
            halfBase, 0, -halfBase,   // 1: back-right
            halfBase, 0, halfBase,    // 2: front-right
            -halfBase, 0, halfBase,   // 3: front-left
            
            // Apex (pointing down)
            0, -this.height, 0,       // 4: apex
        ];
        
        // Indices for 6 triangles (2 for bottom, 4 for sides)
        const indices = [
            // Bottom face triangles (CCW - facing up)
            0, 3, 2,  // First triangle of bottom face
            0, 2, 1,  // Second triangle of bottom face
            
            // Side triangles (all share the apex at index 4)
            // Back face
            4, 1, 0,
            // Right face
            4, 2, 1,
            // Front face
            4, 3, 2,
            // Left face
            4, 0, 3,
        ];
        
        const normals = [];
        const colors = [];
        
        // Calculate face normals and assign colors
        // For each triangle in indices
        for (let i = 0; i < indices.length; i += 3) {
            const i1 = indices[i];
            const i2 = indices[i + 1];
            const i3 = indices[i + 2];
            
            // Get vertices
            const v1 = [vertices[i1*3], vertices[i1*3+1], vertices[i1*3+2]];
            const v2 = [vertices[i2*3], vertices[i2*3+1], vertices[i2*3+2]];
            const v3 = [vertices[i3*3], vertices[i3*3+1], vertices[i3*3+2]];
            
            // Calculate normal
            const edge1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
            const edge2 = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];
            
            let normal = [
                edge1[1] * edge2[2] - edge1[2] * edge2[1],
                edge1[2] * edge2[0] - edge1[0] * edge2[2],
                edge1[0] * edge2[1] - edge1[1] * edge2[0]
            ];
            
            // Normalize
            const length = Math.sqrt(normal[0]**2 + normal[1]**2 + normal[2]**2);
            normal = [normal[0]/length, normal[1]/length, normal[2]/length];
            
            // Determine if this is a bottom face (ground) or side face (dirt)
            // Bottom faces have all vertices at y = 0
            const isBottomFace = v1[1] === 0 && v2[1] === 0 && v3[1] === 0;
            const color = isBottomFace ? this.groundColor : this.dirtColor;
            
            // Add normal and color for each vertex of this triangle
            for (let j = 0; j < 3; j++) {
                normals.push(normal[0], normal[1], normal[2]);
                colors.push(color[0], color[1], color[2]);
            }
        }
        
        this.geometry = new Geometry(this.gl, vertices, indices, normals, colors);
    }
    
    addVegetation(count = 15) {
        const halfBase = this.baseSize / 2 - 0.3; // Keep vegetation away from edges
        
        for (let i = 0; i < count; i++) {
            // Generate random position within THIS island's boundaries
            const x = (Math.random() - 0.5) * halfBase * 2;
            const z = (Math.random() - 0.5) * halfBase * 2;
            
            // Ensure position is within island bounds
            if (Math.abs(x) > halfBase - 0.2 || Math.abs(z) > halfBase - 0.2) {
                continue; // Skip this vegetation if too close to edge
            }
            
            const rand = Math.random();
            
            if (rand > 0.6) {
                // Tree
                this.createTree(x, z);
            } else if (rand > 0.3) {
                // Bush
                this.createBush(x, z);
            } else {
                // Boulder
                this.createBoulder(x, z);
            }
        }
    }
    
    createTree(x, z) {
        const trunkHeight = 0.4 + Math.random() * 0.3;
        const trunkRadius = 0.04 + Math.random() * 0.03;
        const canopySize = 0.25 + Math.random() * 0.1;
        
        // Tree trunk (taller cylinder)
        this.vegetation.push({
            type: 'cylinder',
            position: [x, 0, z],  // Start at island surface
            scale: [trunkRadius, trunkHeight, trunkRadius],
            color: [0.4, 0.3, 0.2]  // Brown trunk
        });
        
        // Tree canopy - positioned at the top of the trunk
        this.vegetation.push({
            type: 'sphere',
            position: [x, trunkHeight, z],  // On top of trunk
            scale: [canopySize, canopySize * 0.8, canopySize],
            color: [0.1 + Math.random() * 0.1, 0.5 + Math.random() * 0.2, 0.1 + Math.random() * 0.05]
        });
    }
    
    createBush(x, z) {
        const bushHeight = 0.15 + Math.random() * 0.1;
        const bushRadius = 0.12 + Math.random() * 0.08;
        
        // Bush (single sphere)
        this.vegetation.push({
            type: 'sphere',
            position: [x, bushHeight * 0.5, z],  // Half embedded in ground
            scale: [bushRadius, bushHeight, bushRadius],
            color: [0.2 + Math.random() * 0.1, 0.5 + Math.random() * 0.2, 0.2 + Math.random() * 0.1]
        });
    }
    
    createBoulder(x, z) {
        const boulderSize = 0.12 + Math.random() * 0.15;
        
        // Boulder (sphere)
        this.vegetation.push({
            type: 'sphere',
            position: [x, boulderSize * 0.5, z],  // Half embedded in ground
            scale: [boulderSize, boulderSize * 0.8, boulderSize],
            color: [0.35 + Math.random() * 0.1, 0.35 + Math.random() * 0.1, 0.35 + Math.random() * 0.1]
        });
    }
    
    update(time) {
        // Floating animation - up and down motion
        this.floatOffset = Math.sin(time * this.floatSpeed) * this.floatAmplitude;
    }
    
    draw(shader) {
        shader.use();
        
        // Create model matrix for this island
        const modelMatrix = mat4.create();
        
        // Apply island position
        mat4.translate(modelMatrix, modelMatrix, this.position);
        
        // Apply floating animation
        mat4.translate(modelMatrix, modelMatrix, [0, this.floatOffset, 0]);
        
        // Set the model matrix uniform
        this.gl.uniformMatrix4fv(shader.getUniformLocation('uModelMatrix'), false, modelMatrix);
        
        // Draw the island geometry
        this.geometry.draw(shader);
        
        return modelMatrix;
    }
    
    drawVegetation(shader, scene) {
        shader.use();
        
        // For each vegetation piece on this island
        this.vegetation.forEach(veg => {
            // Create model matrix for this vegetation
            const modelMatrix = mat4.create();
            
            // Start with island position
            mat4.translate(modelMatrix, modelMatrix, this.position);
            
            // Apply floating animation so vegetation floats WITH the island
            mat4.translate(modelMatrix, modelMatrix, [0, this.floatOffset, 0]);
            
            // Apply vegetation position (relative to island)
            mat4.translate(modelMatrix, modelMatrix, veg.position);
            
            // Apply vegetation scale
            mat4.scale(modelMatrix, modelMatrix, veg.scale);
            
            // Set the model matrix uniform
            this.gl.uniformMatrix4fv(shader.getUniformLocation('uModelMatrix'), false, modelMatrix);
            
            // Get the appropriate geometry with the correct color
            const vegGeometry = veg.type === 'sphere' 
                ? scene.getSphereGeometry(veg.color)
                : scene.getCylinderGeometry(veg.color);
            
            // Draw the vegetation
            vegGeometry.draw(shader);
        });
    }
}

// Create sphere geometry with custom color
function createSphereGeometry(gl, color = [1, 1, 1], segments = 12) {
    const vertices = [];
    const indices = [];
    const normals = [];
    const colors = [];
    
    for (let lat = 0; lat <= segments; lat++) {
        const theta = lat * Math.PI / segments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        
        for (let lon = 0; lon <= segments; lon++) {
            const phi = lon * 2 * Math.PI / segments;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);
            
            const x = cosPhi * sinTheta;
            const y = cosTheta;
            const z = sinPhi * sinTheta;
            
            vertices.push(x, y, z);
            normals.push(x, y, z);
            colors.push(color[0], color[1], color[2]);
        }
    }
    
    for (let lat = 0; lat < segments; lat++) {
        for (let lon = 0; lon < segments; lon++) {
            const first = (lat * (segments + 1)) + lon;
            const second = first + segments + 1;
            
            indices.push(first, second, first + 1);
            indices.push(second, second + 1, first + 1);
        }
    }
    
    return new Geometry(gl, vertices, indices, normals, colors);
}

// Create cylinder geometry with custom color
function createCylinderGeometry(gl, color = [1, 1, 1], segments = 12) {
    const vertices = [];
    const indices = [];
    const normals = [];
    const colors = [];
    
    // Create vertices for top and bottom circles
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle);
        const z = Math.sin(angle);
        
        // Top circle (y = 0.5)
        vertices.push(x, 0.5, z);
        normals.push(x, 0, z);
        colors.push(color[0], color[1], color[2]);
        
        // Bottom circle (y = -0.5)
        vertices.push(x, -0.5, z);
        normals.push(x, 0, z);
        colors.push(color[0], color[1], color[2]);
    }
    
    // Create side faces
    for (let i = 0; i < segments; i++) {
        const topLeft = i * 2;
        const topRight = (i + 1) * 2;
        const bottomLeft = i * 2 + 1;
        const bottomRight = (i + 1) * 2 + 1;
        
        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
    }
    
    // Add top cap (facing up)
    const centerTop = vertices.length / 3;
    vertices.push(0, 0.5, 0);
    normals.push(0, 1, 0);
    colors.push(color[0], color[1], color[2]);
    
    // Add bottom cap (facing down)
    const centerBottom = vertices.length / 3;
    vertices.push(0, -0.5, 0);
    normals.push(0, -1, 0);
    colors.push(color[0], color[1], color[2]);
    
    // Create caps
    for (let i = 0; i < segments; i++) {
        const topVertex = i * 2;
        const nextTopVertex = ((i + 1) % segments) * 2;
        
        // Top cap triangles
        indices.push(centerTop, topVertex, nextTopVertex);
        
        const bottomVertex = i * 2 + 1;
        const nextBottomVertex = ((i + 1) % segments) * 2 + 1;
        
        // Bottom cap triangles
        indices.push(centerBottom, nextBottomVertex, bottomVertex);
    }
    
    return new Geometry(gl, vertices, indices, normals, colors);
}

class ShadowMap {
    constructor(gl, width = 1024, height = 1024) {
        this.gl = gl;
        this.width = width;
        this.height = height;
        
        // Create framebuffer
        this.framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        
        // Create texture for color attachment
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA,
            width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
        );
        
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        
        // Create renderbuffer for depth
        this.depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
        
        // Attach texture and renderbuffer to framebuffer
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
        
        // Check framebuffer status
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            console.error('Framebuffer incomplete');
        }
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // Create shadow shader
        this.shader = new Shader(gl, shadowVertexShaderSource, shadowFragmentShaderSource);
    }
    
    begin() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.shader.use();
    }
    
    end() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
}

// Main scene class
class FloatingIslandScene {
    constructor() {
        this.gl = gl;
        this.islands = [];
        this.shadowMap = null;
        this.mainShader = null;
        this.time = 0;
        this.cameraAngle = 0;
        this.cameraDistance = 15;
        this.cameraX = 0;
        this.lightRotation = Math.PI / 4;
        this.keysPressed = {};
        
        // Geometry caches
        this.sphereGeometries = {};
        this.cylinderGeometries = {};
        
        this.init();
        this.setupEventListeners();
        this.animate();
    }
    
    getSphereGeometry(color) {
        const key = color.join(',');
        if (!this.sphereGeometries[key]) {
            this.sphereGeometries[key] = createSphereGeometry(this.gl, color);
        }
        return this.sphereGeometries[key];
    }
    
    getCylinderGeometry(color) {
        const key = color.join(',');
        if (!this.cylinderGeometries[key]) {
            this.cylinderGeometries[key] = createCylinderGeometry(this.gl, color);
        }
        return this.cylinderGeometries[key];
    }
    
    init() {
        const gl = this.gl;
        
        // Enable depth testing
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        
        // Create shaders
        this.mainShader = new Shader(gl, vertexShaderSource, fragmentShaderSource);
        
        // Create shadow map
        this.shadowMap = new ShadowMap(gl, 1024, 1024);
        
        // Create islands with distinct colors
        const island1 = new PyramidIsland(gl, 3.0, 4.0);
        island1.position = [-4, 0, 0];
        island1.floatSpeed = 0.4;
        island1.floatAmplitude = 0.08;
        island1.groundColor = [0.2, 0.7, 0.3];  // Bright green grass
        island1.dirtColor = [0.45, 0.3, 0.15]; // Brown dirt
        island1.addVegetation(12);
        this.islands.push(island1);
        
        const island2 = new PyramidIsland(gl, 2.5, 3.5);
        island2.position = [4, 0, 0];
        island2.floatSpeed = 0.6;
        island2.floatAmplitude = 0.12;
        island2.groundColor = [0.25, 0.65, 0.25]; // Darker green grass
        island2.dirtColor = [0.5, 0.35, 0.2];    // Lighter brown dirt
        island2.addVegetation(10);
        this.islands.push(island2);
        
        // Setup camera
        this.camera = {
            position: [0, 5, 15],
            target: [0, 0, 0],
            up: [0, 1, 0],
            fov: 45 * Math.PI / 180,
            aspect: canvas.width / canvas.height,
            near: 0.1,
            far: 100.0
        };
        
        // Setup light (spotlight)
        this.light = {
            position: [0, 10, 5],
            target: [0, 0, 0],
            up: [0, 1, 0],
            fov: 60 * Math.PI / 180,
            near: 1.0,
            far: 25.0
        };
    }
    
    setupEventListeners() {
        let isDragging = false;
        let lastX = 0;
        
        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
        });
        
        canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const deltaX = e.clientX - lastX;
            lastX = e.clientX;
            
            // Rotate camera around scene
            this.cameraAngle += deltaX * 0.01;
        });
        
        canvas.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSpeed = 0.1;
            this.cameraDistance += e.deltaY * zoomSpeed;
            this.cameraDistance = Math.max(5, Math.min(30, this.cameraDistance));
        });
        
        // Keyboard controls
        window.addEventListener('keydown', (e) => {
            this.keysPressed[e.key.toLowerCase()] = true;
            
            // Prevent default behavior for arrow keys to avoid scrolling
            if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
        });
        
        window.addEventListener('keyup', (e) => {
            this.keysPressed[e.key.toLowerCase()] = false;
        });
    }
    
    updateCamera() {
        // Calculate camera position based on spherical coordinates with cameraX offset
        const camX = Math.sin(this.cameraAngle) * this.cameraDistance + this.cameraX;
        const camZ = Math.cos(this.cameraAngle) * this.cameraDistance;
        this.camera.position = [camX, 5, camZ];
        this.camera.target = [this.cameraX, 0, 0];
        
        // Update camera aspect ratio
        this.camera.aspect = canvas.width / canvas.height;
    }
    
    updateLight() {
        // Calculate light position based on rotation
        const lightX = Math.sin(this.lightRotation) * 8;
        const lightZ = Math.cos(this.lightRotation) * 8;
        this.light.position = [lightX, 10, lightZ];
        this.light.target = [0, 0, 0];
    }
    
    handleInput() {
        const speed = 0.05;
        
        // Camera rotation (← →)
        if (this.keysPressed['arrowleft']) this.cameraAngle -= speed;
        if (this.keysPressed['arrowright']) this.cameraAngle += speed;
        
        // Camera zoom (↑ ↓)
        if (this.keysPressed['arrowup']) {
            this.cameraDistance -= speed * 2;
            this.cameraDistance = Math.max(5, this.cameraDistance);
        }
        if (this.keysPressed['arrowdown']) {
            this.cameraDistance += speed * 2;
            this.cameraDistance = Math.min(30, this.cameraDistance);
        }
        
        // Camera horizontal movement (Q/E)
        if (this.keysPressed['q']) this.cameraX -= speed * 2;
        if (this.keysPressed['e']) this.cameraX += speed * 2;
        
        // Light rotation (A/D) - changes shadows
        if (this.keysPressed['a']) this.lightRotation -= speed;
        if (this.keysPressed['d']) this.lightRotation += speed;
    }
    
    update() {
        this.time += 0.01;
        this.handleInput();
        
        // Update islands with floating animation
        this.islands.forEach(island => {
            island.update(this.time);
        });
        
        // Update camera and light positions
        this.updateCamera();
        this.updateLight();
    }
    
    renderShadowPass() {
        const gl = this.gl;
        const shadowShader = this.shadowMap.shader;
        
        this.shadowMap.begin();
        shadowShader.use();
        
        // Set light view and projection matrices
        const lightViewMatrix = mat4.create();
        mat4.lookAt(lightViewMatrix, this.light.position, this.light.target, this.light.up);
        
        const lightProjectionMatrix = mat4.create();
        mat4.perspective(lightProjectionMatrix, this.light.fov, 1.0, this.light.near, this.light.far);
        
        gl.uniformMatrix4fv(shadowShader.getUniformLocation('uLightViewMatrix'), false, lightViewMatrix);
        gl.uniformMatrix4fv(shadowShader.getUniformLocation('uLightProjectionMatrix'), false, lightProjectionMatrix);
        
        // Draw islands and their vegetation to shadow map
        this.islands.forEach(island => {
            // Draw the island itself
            island.draw(shadowShader);
            
            // Draw vegetation on this island
            island.drawVegetation(shadowShader, this);
        });
        
        this.shadowMap.end();
    }
    
    renderMainPass() {
        const gl = this.gl;
        
        // Clear with sky blue background
        gl.clearColor(0.53, 0.81, 0.92, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        
        this.mainShader.use();
        
        // Set view and projection matrices
        const viewMatrix = mat4.create();
        mat4.lookAt(viewMatrix, this.camera.position, this.camera.target, this.camera.up);
        
        const projectionMatrix = mat4.create();
        mat4.perspective(projectionMatrix, this.camera.fov, this.camera.aspect, this.camera.near, this.camera.far);
        
        // Set light view and projection matrices for shadow mapping
        const lightViewMatrix = mat4.create();
        mat4.lookAt(lightViewMatrix, this.light.position, this.light.target, this.light.up);
        
        const lightProjectionMatrix = mat4.create();
        mat4.perspective(lightProjectionMatrix, this.light.fov, 1.0, this.light.near, this.light.far);
        
        // Set uniforms
        gl.uniformMatrix4fv(this.mainShader.getUniformLocation('uViewMatrix'), false, viewMatrix);
        gl.uniformMatrix4fv(this.mainShader.getUniformLocation('uProjectionMatrix'), false, projectionMatrix);
        gl.uniformMatrix4fv(this.mainShader.getUniformLocation('uLightViewMatrix'), false, lightViewMatrix);
        gl.uniformMatrix4fv(this.mainShader.getUniformLocation('uLightProjectionMatrix'), false, lightProjectionMatrix);
        gl.uniform3fv(this.mainShader.getUniformLocation('uLightPosition'), this.light.position);
        gl.uniform1f(this.mainShader.getUniformLocation('uShadowBias'), 0.005);
        
        // Bind shadow map texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.shadowMap.texture);
        gl.uniform1i(this.mainShader.getUniformLocation('uShadowMap'), 0);
        
        // Draw islands and their vegetation
        this.islands.forEach(island => {
            // Draw the island itself (with correct grass/dirt colors)
            island.draw(this.mainShader);
            
            // Draw vegetation on this island
            island.drawVegetation(this.mainShader, this);
        });
    }
    
    animate() {
        this.update();
        this.renderShadowPass();
        this.renderMainPass();
        requestAnimationFrame(() => this.animate());
    }
}

// Initialize scene when page loads
window.addEventListener('load', () => {
    new FloatingIslandScene();
});