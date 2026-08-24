import Foundation
import Security
import Darwin

func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data(code.utf8))
    exit(41)
}

guard CommandLine.arguments.count == 4, CommandLine.arguments[1] == "add" else {
    fail("CONTROL_ROOM_MAC_FIXTURE_INVALID")
}

let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
guard service.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$"#, options: .regularExpression) != nil,
      account.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$"#, options: .regularExpression) != nil else {
    fail("CONTROL_ROOM_MAC_FIXTURE_INVALID")
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count >= 32 && input.count <= 16_384 else {
    fail("CONTROL_ROOM_MAC_FIXTURE_INVALID")
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecValueData as String: input,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
]

let status = SecItemAdd(query as CFDictionary, nil)
guard status == errSecSuccess else {
    fail(status == errSecDuplicateItem ? "CONTROL_ROOM_MAC_FIXTURE_DUPLICATE" : "CONTROL_ROOM_MAC_FIXTURE_ADD_FAILED")
}

FileHandle.standardOutput.write(Data("CONTROL_ROOM_MAC_FIXTURE_ADDED".utf8))
