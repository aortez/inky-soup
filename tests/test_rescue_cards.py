"""Validate committed build-time assets with the display's real pixel decoder."""
from pathlib import Path
import unittest
from PIL import Image
from test_update_image import UPDATE_IMAGE, make_display


class RescueCardsTest(unittest.TestCase):
    def test_both_panels_and_mounts_have_crisp_native_palette_assets(self):
        root = Path(__file__).resolve().parents[1] / 'upload-server' / 'rescue-cards'
        for width, height in [(600, 448), (1600, 1200)]:
            for degrees in [0, 90, 180, 270]:
                size = (width, height) if degrees % 180 == 0 else (height, width)
                with self.subTest(size=size, degrees=degrees):
                    with Image.open(root / f'{size[0]}x{size[1]}.png') as image:
                        self.assertEqual(image.size, size)
                        self.assertEqual(image.mode, 'RGB')
                        colors = image.getcolors(maxcolors=3)
                        self.assertIsNotNone(colors)
                        self.assertEqual({color for _, color in colors}, {(0, 0, 0), (255, 255, 255)})
                        rotated = UPDATE_IMAGE.rotate_image(image, (360 - degrees) % 360)
                        driver = 'inky_uc8159' if width == 600 else 'inky_el133uf1'
                        display = make_display(driver, width, height)
                        UPDATE_IMAGE.set_pre_dithered_image(display, rotated)
                        self.assertEqual(display.buf.shape, (height, width))
                        self.assertTrue(((display.buf == 0) | (display.buf == 1)).all())
                        # Text above and QR below the middle both contain ink.
                        for box in [(0, 0, size[0], size[1] // 2),
                                    (size[0] // 4, size[1] // 2, size[0] * 3 // 4, size[1] * 4 // 5)]:
                            self.assertEqual(image.crop(box).getextrema()[0], (0, 255))


if __name__ == '__main__':
    unittest.main()
