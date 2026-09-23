import Foundation

/// Deforming garment lattice from tracked-mesh JSON.
/// Symbol icons are mesh UV points, reprojected with the frame that matches video time.
final class GarmentMesh: @unchecked Sendable {
    let cols: Int
    let rows: Int
    let canvasWidth: Float
    let canvasHeight: Float
    private let times: [Float]
    private let frames: [[Float]]
    let symbols: [Float]
    private var sample: [Float]

    var symbolCount: Int { symbols.count / 2 }

    init(
        cols: Int,
        rows: Int,
        canvasWidth: Float,
        canvasHeight: Float,
        times: [Float],
        frames: [[Float]],
        symbols: [Float]
    ) {
        self.cols = cols
        self.rows = rows
        self.canvasWidth = canvasWidth
        self.canvasHeight = canvasHeight
        self.times = times
        self.frames = frames
        self.symbols = symbols
        self.sample = Array(repeating: 0, count: cols * rows * 2)
    }

    func sampleVerts(timeSec: Float) -> [Float] {
        guard !frames.isEmpty else { return sample }
        let duration = times.last ?? 0
        let t = (duration > 0 && times.count > 1) ? timeSec.truncatingRemainder(dividingBy: duration) : timeSec
        var prev = 0
        var next = times.count - 1
        for i in times.indices {
            if times[i] <= t { prev = i }
            if times[i] >= t {
                next = i
                break
            }
        }
        let span = times[next] - times[prev]
        let alpha: Float = span <= 1e-4 ? 0 : max(0, min(1, (t - times[prev]) / span))
        let a = frames[prev]
        let b = frames[next]
        for i in sample.indices {
            sample[i] = a[i] + (b[i] - a[i]) * alpha
        }
        return sample
    }

    /// Bilinear lookup. u,v are 0–1 across the grid.
    func uvToWorld(verts: [Float], u: Float, v: Float) -> (Float, Float) {
        let gx = max(0, min(Float(cols - 1), u * Float(cols - 1)))
        let gy = max(0, min(Float(rows - 1), v * Float(rows - 1)))
        let x0 = Int(floor(gx))
        let y0 = Int(floor(gy))
        let x1 = min(cols - 1, x0 + 1)
        let y1 = min(rows - 1, y0 + 1)
        let fx = gx - Float(x0)
        let fy = gy - Float(y0)
        func vx(_ x: Int, _ y: Int) -> Float { verts[(y * cols + x) * 2] }
        func vy(_ x: Int, _ y: Int) -> Float { verts[(y * cols + x) * 2 + 1] }
        let topX = vx(x0, y0) + (vx(x1, y0) - vx(x0, y0)) * fx
        let topY = vy(x0, y0) + (vy(x1, y0) - vy(x0, y0)) * fx
        let botX = vx(x0, y1) + (vx(x1, y1) - vx(x0, y1)) * fx
        let botY = vy(x0, y1) + (vy(x1, y1) - vy(x0, y1)) * fy
        return (topX + (botX - topX) * fy, topY + (botY - topY) * fy)
    }

    static func parse(_ raw: String) -> GarmentMesh? {
        guard raw.contains("\"symbolPoints\"") else { return nil }
        guard let data = raw.data(using: .utf8) else { return nil }
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        var cols = 0
        var rows = 0
        var canvasWidth: Float = 390
        var canvasHeight: Float = 672
        if let canvas = root["canvas"] as? [String: Any] {
            if let w = canvas["width"] as? Double { canvasWidth = Float(w) }
            if let h = canvas["height"] as? Double { canvasHeight = Float(h) }
            if let w = canvas["width"] as? Int { canvasWidth = Float(w) }
            if let h = canvas["height"] as? Int { canvasHeight = Float(h) }
        }
        if let mesh = root["mesh"] as? [String: Any] {
            cols = (mesh["cols"] as? Int) ?? Int(mesh["cols"] as? Double ?? 0)
            rows = (mesh["rows"] as? Int) ?? Int(mesh["rows"] as? Double ?? 0)
        }
        guard cols >= 2, rows >= 2 else { return nil }
        let expected = cols * rows

        var times: [Float] = []
        var frames: [[Float]] = []
        if let frameList = root["frames"] as? [[String: Any]] {
            for frame in frameList {
                let t: Float
                if let d = frame["t"] as? Double { t = Float(d) }
                else if let i = frame["t"] as? Int { t = Float(i) }
                else { t = 0 }
                guard let vertsRaw = frame["verts"] as? [[Any]] else { return nil }
                var packed = [Float](repeating: 0, count: expected * 2)
                guard vertsRaw.count == expected else { return nil }
                for (i, pair) in vertsRaw.enumerated() {
                    guard pair.count >= 2 else { return nil }
                    let x: Float
                    let y: Float
                    if let xd = pair[0] as? Double, let yd = pair[1] as? Double {
                        x = Float(xd); y = Float(yd)
                    } else if let xi = pair[0] as? Int, let yi = pair[1] as? Int {
                        x = Float(xi); y = Float(yi)
                    } else {
                        return nil
                    }
                    packed[i * 2] = x
                    packed[i * 2 + 1] = y
                }
                times.append(t)
                frames.append(packed)
            }
        }
        guard !times.isEmpty else { return nil }

        var symbols: [Float] = []
        if let points = root["symbolPoints"] as? [[String: Any]] {
            for point in points {
                let u: Float
                let v: Float
                if let ud = point["u"] as? Double, let vd = point["v"] as? Double {
                    u = Float(ud); v = Float(vd)
                } else if let ui = point["u"] as? Int, let vi = point["v"] as? Int {
                    u = Float(ui); v = Float(vi)
                } else {
                    u = 0; v = 0
                }
                symbols.append(u)
                symbols.append(v)
            }
        }
        guard symbols.count >= 12 else { return nil }

        return GarmentMesh(
            cols: cols,
            rows: rows,
            canvasWidth: canvasWidth,
            canvasHeight: canvasHeight,
            times: times,
            frames: frames,
            symbols: symbols
        )
    }
}
