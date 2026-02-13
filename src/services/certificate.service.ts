import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { CloudinaryService } from "./cloudinary.service";

export class CertificateService {
  private cloudinaryService: CloudinaryService;

  constructor() {
    this.cloudinaryService = new CloudinaryService();
  }

  async generateCertificate(
    studentName: string,
    courseName: string,
    date: Date,
    certificateId: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        layout: "landscape",
        size: "A4",
        margin: 0
      });

      const buffers: Buffer[] = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", async () => {
        const pdfBuffer = Buffer.concat(buffers);
        try {
          // Upload to Cloudinary using uploadImage (handles PDFs with resource_type: "auto")
          // We explicitly pass "jpg" format to ensure the URL ends in .jpg and renders immediately in browser
          const result = await this.cloudinaryService.uploadImage(pdfBuffer, "certificates", "jpg");
          resolve(result.secure_url);
        } catch (error) {
          reject(error);
        }
      });

      // Background
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#fefefe");

      // CNT Blue Bottom (35% from bottom)
      const bottomHeight = doc.page.height * 0.35;
      doc.rect(0, doc.page.height - bottomHeight, doc.page.width, bottomHeight).fill("#2094D2");

      // Watermarks (Relieve) - Subtle & Background
      doc.save();
      doc.fillColor("#bdc3c7");
      doc.opacity(0.05); // Even more subtle (5%)
      doc.fontSize(80); // Slightly larger
      doc.font("Helvetica-Bold");

      // Top Right Watermark Text
      doc.text("CERTIFICADO", 0, 50, {
        align: "right",
        width: doc.page.width - 50, // Padding from right
      });

      // Bottom Left Watermark Text
      doc.text("CERTIFICADO", 50, doc.page.height - 120, {
        align: "left",
        width: doc.page.width
      });

      // SEALS (Sellos) - Professional Watermark
      const selloPath = path.join(process.cwd(), "src", "static", "sello", "sello.png");
      if (fs.existsSync(selloPath)) {
        const selloSize = 300;
        doc.opacity(0.05); // Very subtle opacity for the background seals

        // Sello 1: Bottom Right (Background style)
        doc.image(selloPath, doc.page.width - selloSize + 50, doc.page.height - selloSize + 50, {
          width: selloSize
        });

        // Sello 2: Top Left (Background style)
        doc.image(selloPath, -50, -50, {
          width: selloSize
        });
      }
      doc.restore();

      // Border
      doc.lineWidth(10);
      doc.strokeColor("#010D27");
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke();

      // Logo
      const logoPath = path.join(process.cwd(), "src", "static", "logo", "logo.png");
      if (fs.existsSync(logoPath)) {
        const logoWidth = 200;
        const logoX = (doc.page.width - logoWidth) / 2;
        doc.image(logoPath, logoX, 40, { width: logoWidth });
      }

      // Content with Absolute Positioning to ensure single page
      const centerX = 0;
      const pageWidth = doc.page.width;

      doc.fillColor("#010D27").fontSize(40).font("Helvetica-Bold").text("CERTIFICADO DE FINALIZACIÓN", centerX, 140, { align: "center", width: pageWidth });

      doc.fillColor("#010D27").fontSize(20).font("Helvetica-Bold").text("Se certifica que", centerX, 190, { align: "center", width: pageWidth });

      doc.fillColor("#010D27").fontSize(35).font("Helvetica-Bold").text(studentName.toUpperCase(), centerX, 220, { align: "center", width: pageWidth });

      doc.fillColor("#010D27").fontSize(20).font("Helvetica-Bold").text("ha completado con éxito el curso", centerX, 270, { align: "center", width: pageWidth });

      doc.fillColor("#010D27").fontSize(30).font("Helvetica-Bold").text(courseName, centerX, 300, { align: "center", width: pageWidth });

      doc.fillColor("#010D27").fontSize(15).font("Helvetica-Bold").text(`Fecha: ${date.toLocaleDateString("es-ES")}`, centerX, 350, { align: "center", width: pageWidth });

      // Signatures - Positioned below the date
      const signatureY = 400;
      const signatureWidth = 120;

      // Luis Signature (Left)
      const luisSignaturePath = path.join(process.cwd(), "src", "static", "signatures", "luis", "luis-signature.png");
      if (fs.existsSync(luisSignaturePath)) {
        const luisX = (pageWidth / 4) - (signatureWidth / 2);
        doc.image(luisSignaturePath, luisX, signatureY, { width: signatureWidth });

        doc.fillColor("#010D27").fontSize(12).font("Helvetica-Bold").text("Luis Reyes", luisX, signatureY + 60, { width: signatureWidth, align: "center" });
        doc.fillColor("#010D27").fontSize(10).font("Helvetica-Bold").text("CEO", luisX, signatureY + 75, { width: signatureWidth, align: "center" });
      }

      // Mauro Signature (Right)
      const mauroSignaturePath = path.join(process.cwd(), "src", "static", "signatures", "mauro", "mauro-signature.png");
      if (fs.existsSync(mauroSignaturePath)) {
        const mauroSignatureWidth = 180; // Increased size
        const mauroX = (pageWidth * 3 / 4) - (mauroSignatureWidth / 2);
        // Adjusted Y to be level with Luis (removed -15 offset)
        doc.image(mauroSignaturePath, mauroX, signatureY, { width: mauroSignatureWidth });

        doc.fillColor("#010D27").fontSize(12).font("Helvetica-Bold").text("Mauro Salgán", mauroX, signatureY + 60, { width: mauroSignatureWidth, align: "center" });
        doc.fillColor("#010D27").fontSize(10).font("Helvetica-Bold").text("COO", mauroX, signatureY + 75, { width: mauroSignatureWidth, align: "center" });
      }


      // Verification Code
      doc.fillColor("#010D27").fontSize(10).font("Helvetica-Bold").text(`Verification Code: ${certificateId}`, centerX, 550, { align: "center", width: pageWidth });

      doc.end();
    });
  }
}

export const certificateService = new CertificateService();
