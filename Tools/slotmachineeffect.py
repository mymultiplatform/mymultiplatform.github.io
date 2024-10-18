import tkinter as tk
import math

class SlotMachineApp:
    def __init__(self, master):
        self.master = master
        master.title("3D Slot Machine")

        # Canvas to draw on
        self.canvas = tk.Canvas(master, width=400, height=400, bg="black")
        self.canvas.pack()

        # Words to display
        self.words = ["LIGHT", "POWER", "LOVE", "SEX"]
        self.current_word_index = 0  # Track the current word
        self.y_position = 400  # Initial position for the first word
        self.word_height = 60  # Height of each word for spacing
        self.speed = 5  # Speed of the movement
        self.font_size = 40  # Normal font size
        self.font = ("Helvetica", self.font_size)
        self.frame_count = 0  # Track the frame count for bending effect

        # Start the rotation
        self.animate_words()

    def animate_words(self):
        # Clear the canvas
        self.canvas.delete("all")

        # Draw the current word
        word = self.words[self.current_word_index]

        # Calculate bending and oscillation effect
        bend_factor = 30  # Controls the bending effect
        oscillation_amplitude = 15  # Controls the oscillation amplitude
        oscillation_frequency = 5  # Controls how fast the oscillation occurs
        
        # Calculate effective y position with bending
        bending_offset = (self.y_position - 200) / 200  # Calculate how far from center
        effective_y_position = self.y_position + (bend_factor * bending_offset ** 2)

        # Add vertical oscillation
        oscillation = oscillation_amplitude * math.sin(self.frame_count / oscillation_frequency)
        effective_y_position += oscillation

        # Calculate distance to the center for scaling
        distance_to_center = abs(effective_y_position - 200)

        # Scale font size based on distance to center
        scale_factor = max(0.5, (100 - distance_to_center) / 100)  # Scale between 0.5 and 1
        current_font_size = int(self.font_size * scale_factor * 1.5)  # Increase size for more impact

        # Draw the word with a shadow effect
        self.canvas.create_text(200 + 2, effective_y_position + 2, text=word, font=("Helvetica", current_font_size), fill="grey")
        self.canvas.create_text(200, effective_y_position, text=word, font=("Helvetica", current_font_size), fill="white")

        # Update the y position for the animation
        self.y_position -= self.speed

        # Reset position and update word index when the word moves out of view
        if self.y_position < -self.word_height:
            self.y_position = 400  # Reset to the bottom
            self.current_word_index = (self.current_word_index + 1) % len(self.words)

        # Increment frame count for oscillation effect
        self.frame_count += 1

        # Call this function again after 50 milliseconds for smooth animation
        self.master.after(50, self.animate_words)

# Create the Tkinter window and run the application
root = tk.Tk()
app = SlotMachineApp(root)
root.mainloop()
