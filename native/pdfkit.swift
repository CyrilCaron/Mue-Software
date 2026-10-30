// Petit utilitaire macOS (PDFKit) pour ce que pdf-lib ne sait pas faire : le chiffrement.
//   mue-pdfkit check   <entrée>                         → "ouvert" | "protege"
//   mue-pdfkit encrypt <entrée> <sortie> <mdp> [mdp-propriétaire]
//   mue-pdfkit decrypt <entrée> <sortie> <mdp>
import Foundation
import PDFKit

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: mue-pdfkit check|encrypt|decrypt …", 64) }
let command = args[1]
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { fail("PDF illisible", 2) }

switch command {
case "check":
    print(doc.isLocked ? "protege" : "ouvert")
case "encrypt":
    guard args.count >= 5 else { fail("mot de passe manquant", 64) }
    if doc.isLocked { fail("Ce PDF est déjà protégé", 3) }
    let user = args[4]
    let owner = args.count >= 6 && !args[5].isEmpty ? args[5] : user
    let options: [PDFDocumentWriteOption: Any] = [.userPasswordOption: user, .ownerPasswordOption: owner]
    guard doc.write(to: URL(fileURLWithPath: args[3]), withOptions: options) else { fail("Écriture impossible", 4) }
case "decrypt":
    guard args.count >= 5 else { fail("mot de passe manquant", 64) }
    if doc.isLocked && !doc.unlock(withPassword: args[4]) { fail("Mot de passe incorrect", 5) }
    // PDFKit garde la protection en réécrivant le même document : on recopie les pages dans un neuf
    let copy = PDFDocument()
    for i in 0..<doc.pageCount {
        if let page = doc.page(at: i)?.copy() as? PDFPage { copy.insert(page, at: copy.pageCount) }
    }
    if let attrs = doc.documentAttributes { copy.documentAttributes = attrs }
    guard copy.write(to: URL(fileURLWithPath: args[3])) else { fail("Écriture impossible", 4) }
default:
    fail("commande inconnue : \(command)", 64)
}
