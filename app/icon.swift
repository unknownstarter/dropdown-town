// 앱 아이콘(1024px PNG)을 그린다. 화면 속 캐릭터와 같은 12x16 픽셀 도안을 크게 찍는다.
import Cocoa

let out = CommandLine.arguments[1]
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

func color(_ hex: Int) -> NSColor {
  NSColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}
// 둥근 배경
color(0x2a2438).setFill()
NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 200, yRadius: 200).fill()

// 픽셀 한 칸 = 48px, 도안 원점은 왼쪽 위
let px = 48, ox = 224, oy = 140
func dot(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ hex: Int) {
  color(hex).setFill()
  NSRect(x: ox + x * px, y: size - oy - (y + h) * px, width: w * px, height: h * px).fill()
}
dot(3, 13, 2, 3, 0x3a3550); dot(7, 13, 2, 3, 0x3a3550)          // 다리
dot(2, 8, 8, 5, 0xff8a3d); dot(2, 12, 8, 1, 0xc96a2c)            // 몸통
dot(1, 8, 1, 4, 0xff8a3d); dot(10, 8, 1, 4, 0xff8a3d)            // 팔
dot(1, 12, 1, 1, 0xf7d7b5); dot(10, 12, 1, 1, 0xf7d7b5)
dot(2, 1, 8, 7, 0xf7d7b5)                                        // 얼굴
dot(2, 0, 8, 3, 0x2b2230); dot(1, 1, 1, 4, 0x2b2230); dot(10, 1, 1, 4, 0x2b2230) // 머리
dot(4, 4, 1, 2, 0x2a2233); dot(7, 4, 1, 2, 0x2a2233)             // 눈
dot(3, 6, 1, 1, 0xf29c9c); dot(8, 6, 1, 1, 0xf29c9c)             // 볼

NSGraphicsContext.current?.flushGraphics()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
