import Foundation
import Lottie
import Compression

/// Same catalog order as the web match game (`DEFAULT_SYMBOL_TYPES`).
enum SymbolLotties {
    static let files = [
        "01-Heart.lottie",
        "02-Lock.lottie",
        "03-GemDiamond.lottie",
        "04-Star.lottie",
        "05-Diamond.lottie",
        "06-Magnet.lottie",
        "07-Crown.lottie",
        "08-Gold Coins.lottie",
        "09-Key.lottie",
        "10-Treasure Chest.lottie",
        "11-Diamond Cards.lottie",
        "12-WinnerTrophy.lottie",
    ]

    static let labels = [
        "Heart", "Lock", "Gem", "Star", "Diamond", "Magnet",
        "Crown", "Gold Coins", "Key", "Treasure Chest", "Diamond Cards", "Trophy",
    ]

    static func load(api: SugarAPI) async -> [LottieAnimation] {
        await withTaskGroup(of: (Int, LottieAnimation?).self) { group in
            for (index, file) in files.enumerated() {
                group.addTask {
                    do {
                        let bytes = try await api.fetchBytes(api.mediaUrl("/lotties/\(file)"))
                        if let animation = try? await loadDotLottie(bytes) {
                            return (index, animation)
                        }
                        let json = try animationJSON(from: bytes)
                        let animation = try LottieAnimation.from(data: Data(json.utf8))
                        return (index, animation)
                    } catch {
                        return (index, nil)
                    }
                }
            }
            var ordered = Array<LottieAnimation?>(repeating: nil, count: files.count)
            for await (index, animation) in group {
                ordered[index] = animation
            }
            return ordered.compactMap { $0 }
        }
    }

    private static func loadDotLottie(_ bytes: Data) async throws -> LottieAnimation? {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("lottie")
        try bytes.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = try await DotLottieFile.loadedFrom(url: tmp)
        return file.animations.first?.animation
    }

    private static func animationJSON(from bytes: Data) throws -> String {
        guard let json = unzipFirstAnimationJSON(bytes) else {
            throw ApiException(statusCode: 0, message: "dotLottie archive has no animation")
        }
        return json
    }

    private static func unzipFirstAnimationJSON(_ data: Data) -> String? {
        var offset = 0
        let count = data.count
        while offset + 30 <= count {
            let sig: UInt32 = data.subdata(in: offset..<(offset + 4)).withUnsafeBytes { $0.load(as: UInt32.self) }
            guard sig == 0x04034b50 else { break }
            let compression: UInt16 = data.subdata(in: (offset + 8)..<(offset + 10)).withUnsafeBytes { $0.load(as: UInt16.self) }
            let compSize = Int(data.subdata(in: (offset + 18)..<(offset + 22)).withUnsafeBytes { $0.load(as: UInt32.self) })
            let nameLen = Int(data.subdata(in: (offset + 26)..<(offset + 28)).withUnsafeBytes { $0.load(as: UInt16.self) })
            let extraLen = Int(data.subdata(in: (offset + 28)..<(offset + 30)).withUnsafeBytes { $0.load(as: UInt16.self) })
            let nameStart = offset + 30
            let nameEnd = nameStart + nameLen
            guard nameEnd + extraLen + compSize <= count else { break }
            let name = String(data: data.subdata(in: nameStart..<nameEnd), encoding: .utf8) ?? ""
            let dataStart = nameEnd + extraLen
            let dataEnd = dataStart + compSize
            defer { offset = dataEnd }
            let baseName = (name as NSString).lastPathComponent
            if baseName.hasSuffix(".json"), baseName != "manifest.json" {
                let payload = data.subdata(in: dataStart..<dataEnd)
                if compression == 0, let text = String(data: payload, encoding: .utf8) {
                    return text
                }
                if compression == 8, let inflated = inflateRaw(payload), let text = String(data: inflated, encoding: .utf8) {
                    return text
                }
            }
        }
        return nil
    }

    private static func inflateRaw(_ source: Data) -> Data? {
        let dstSize = source.count * 8 + 1024
        var destination = Data(count: dstSize)
        let decoded: Int = destination.withUnsafeMutableBytes { dstPtr in
            source.withUnsafeBytes { srcPtr in
                guard let dst = dstPtr.bindMemory(to: UInt8.self).baseAddress,
                      let src = srcPtr.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_decode_buffer(dst, dstSize, src, source.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard decoded > 0 else { return nil }
        destination.count = decoded
        return destination
    }
}
