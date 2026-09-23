import Foundation
import Metal

enum DualVideoShaders {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct VertexOut {
        float4 position [[position]];
        float2 uv;
    };

    vertex VertexOut dual_video_vertex(uint vid [[vertex_id]]) {
        float2 positions[4] = {
            float2(-1.0, -1.0),
            float2( 1.0, -1.0),
            float2(-1.0,  1.0),
            float2( 1.0,  1.0)
        };
        float2 uvs[4] = {
            float2(0.0, 1.0),
            float2(1.0, 1.0),
            float2(0.0, 0.0),
            float2(1.0, 0.0)
        };
        VertexOut out;
        out.position = float4(positions[vid], 0.0, 1.0);
        out.uv = uvs[vid];
        return out;
    }

    fragment float4 dual_video_fragment(
        VertexOut in [[stage_in]],
        texture2d<float> bgTex [[texture(0)]],
        texture2d<float> fgTex [[texture(1)]],
        texture2d<float> maskTex [[texture(2)]],
        constant float &uChroma [[buffer(0)]]
    ) {
        constexpr sampler linearSampler(address::clamp_to_edge, filter::linear);
        float4 bg = bgTex.sample(linearSampler, in.uv);
        float4 fg = fgTex.sample(linearSampler, in.uv);
        // Mask is authored in UIKit top-left space and uploaded top-row-first.
        // Vertex UV already has v=0 at the top of the drawable.
        float keep = maskTex.sample(linearSampler, in.uv).a;
        float green = step(0.5, uChroma)
            * step(0.27, fg.g)
            * step(fg.r + 0.12, fg.g)
            * step(fg.b + 0.12, fg.g);
        return mix(bg, fg, keep * (1.0 - green));
    }
    """

    static func makeLibrary(device: MTLDevice) throws -> MTLLibrary {
        try device.makeLibrary(source: source, options: nil)
    }
}
