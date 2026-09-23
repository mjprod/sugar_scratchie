import Lottie
import SwiftUI

let gameSymbols = ["Heart", "Lock", "Gem", "Star", "Diamond", "Magnet"]

struct GameTopBar: View {
    var foundMask: Int
    var diamonds: Int
    var coins: Int
    var note: String?
    var symbolAnimations: [LottieAnimation] = []
    var showWallet: Bool = true
    var scratchable: Bool = false
    var onBarCleared: () -> Void = {}

    var body: some View {
        VStack(spacing: 8) {
            if showWallet {
                HStack(spacing: 10) {
                    WalletChip(mark: "◆", value: diamonds, tint: Color(red: 0.494, green: 0.784, blue: 1))
                    WalletChip(mark: "●", value: coins, tint: Color(red: 1, green: 0.835, blue: 0.416))
                }
            }
            ZStack {
                HStack(spacing: 8) {
                    ForEach(Array(gameSymbols.enumerated()), id: \.offset) { index, name in
                        SymbolSlot(
                            name: name,
                            found: ((foundMask >> index) & 1) == 1,
                            animation: symbolAnimations.indices.contains(index) ? symbolAnimations[index] : nil
                        )
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(red: 0.078, green: 0.071, blue: 0.063).opacity(0.62))
                .overlay(
                    RoundedRectangle(cornerRadius: 999)
                        .stroke(Color.white.opacity(0.28), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 999))

                if scratchable {
                    BarFoilView(onCleared: onBarCleared)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if let note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(red: 1, green: 0.906, blue: 0.639))
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct WalletChip: View {
    var mark: String
    var value: Int
    var tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Text(mark)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(tint)
            Text("\(value)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color(red: 0.075, green: 0.071, blue: 0.063).opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: 999)
                .stroke(Color.white.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 999))
    }
}

private struct SymbolSlot: View {
    var name: String
    var found: Bool
    var animation: LottieAnimation?

    var body: some View {
        ZStack {
            Circle()
                .fill(found ? Color(red: 1, green: 0.824, blue: 0.471).opacity(0.2) : Color(red: 0.031, green: 0.027, blue: 0.024).opacity(0.98))
            Circle()
                .stroke(found ? Color(red: 1, green: 0.863, blue: 0.549).opacity(0.75) : Color.white.opacity(0.2), lineWidth: 1)
            if let animation {
                LottieView(animation: animation)
                    .playing(loopMode: .loop)
                    .frame(width: 32, height: 32)
                    .opacity(found ? 1 : 0.45)
            } else {
                SymbolMark(name: name, color: found ? Color(red: 1, green: 0.906, blue: 0.639) : Color(red: 0.416, green: 0.396, blue: 0.376))
                    .frame(width: 26, height: 26)
            }
        }
        .frame(width: 44, height: 44)
    }
}

struct SymbolMark: View {
    var name: String
    var color: Color

    var body: some View {
        Canvas { context, size in
            let w = size.width
            let h = size.height
            switch name {
            case "Heart":
                var path = Path()
                path.move(to: CGPoint(x: w * 0.5, y: h * 0.88))
                path.addCurve(
                    to: CGPoint(x: w * 0.5, y: h * 0.32),
                    control1: CGPoint(x: w * -0.05, y: h * 0.45),
                    control2: CGPoint(x: w * 0.18, y: h * 0.05)
                )
                path.addCurve(
                    to: CGPoint(x: w * 0.5, y: h * 0.88),
                    control1: CGPoint(x: w * 0.82, y: h * 0.05),
                    control2: CGPoint(x: w * 1.05, y: h * 0.45)
                )
                path.closeSubpath()
                context.fill(path, with: .color(color))
            case "Lock":
                context.fill(
                    Path(roundedRect: CGRect(x: w * 0.18, y: h * 0.42, width: w * 0.64, height: h * 0.48), cornerRadius: w * 0.08),
                    with: .color(color)
                )
                var arc = Path()
                arc.addArc(
                    center: CGPoint(x: w * 0.5, y: h * 0.32),
                    radius: w * 0.22,
                    startAngle: .degrees(200),
                    endAngle: .degrees(340),
                    clockwise: false
                )
                context.stroke(arc, with: .color(color), lineWidth: w * 0.09)
            case "Gem":
                var path = Path()
                path.move(to: CGPoint(x: w * 0.5, y: h * 0.08))
                path.addLine(to: CGPoint(x: w * 0.88, y: h * 0.38))
                path.addLine(to: CGPoint(x: w * 0.5, y: h * 0.92))
                path.addLine(to: CGPoint(x: w * 0.12, y: h * 0.38))
                path.closeSubpath()
                context.fill(path, with: .color(color))
            case "Star":
                context.fill(starPath(w: w, h: h), with: .color(color))
            case "Diamond":
                var path = Path()
                path.move(to: CGPoint(x: w * 0.5, y: h * 0.06))
                path.addLine(to: CGPoint(x: w * 0.92, y: h * 0.5))
                path.addLine(to: CGPoint(x: w * 0.5, y: h * 0.94))
                path.addLine(to: CGPoint(x: w * 0.08, y: h * 0.5))
                path.closeSubpath()
                context.stroke(path, with: .color(color), lineWidth: w * 0.09)
            default:
                context.fill(Path(ellipseIn: CGRect(x: w * 0.1, y: h * 0.24, width: w * 0.36, height: h * 0.36)), with: .color(color))
                context.fill(Path(ellipseIn: CGRect(x: w * 0.54, y: h * 0.24, width: w * 0.36, height: h * 0.36)), with: .color(color))
                var stem = Path()
                stem.move(to: CGPoint(x: w * 0.46, y: h * 0.42))
                stem.addLine(to: CGPoint(x: w * 0.54, y: h * 0.42))
                stem.move(to: CGPoint(x: w * 0.5, y: h * 0.42))
                stem.addLine(to: CGPoint(x: w * 0.5, y: h * 0.86))
                context.stroke(stem, with: .color(color), lineWidth: w * 0.08)
            }
        }
    }

    private func starPath(w: CGFloat, h: CGFloat) -> Path {
        let cx = w * 0.5
        let cy = h * 0.52
        let outer = w * 0.46
        let inner = w * 0.2
        var path = Path()
        for i in 0..<10 {
            let radius = i % 2 == 0 ? outer : inner
            let angle = (-90.0 + Double(i) * 36.0) * Double.pi / 180
            let x = cx + radius * CGFloat(cos(angle))
            let y = cy + radius * CGFloat(sin(angle))
            if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        path.closeSubpath()
        return path
    }
}
