import CoreGraphics
import Foundation

let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var windows: [[String: Any]] = []
for w in info {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    func num(_ key: String) -> Double {
        (b[key] as? NSNumber)?.doubleValue ?? 0
    }
    windows.append([
        "id": w[kCGWindowNumber as String] as? Int ?? 0,
        "owner": w[kCGWindowOwnerName as String] as? String ?? "",
        "name": w[kCGWindowName as String] as? String ?? "",
        "x": num("X"),
        "y": num("Y"),
        "w": num("Width"),
        "h": num("Height"),
        "layer": w[kCGWindowLayer as String] as? Int ?? 0,
    ])
}
let data = try JSONSerialization.data(withJSONObject: ["windows": windows])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0A]))
