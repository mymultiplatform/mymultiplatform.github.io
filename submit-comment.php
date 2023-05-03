<?php
  $name = $_POST["name"];
  $comment = $_POST["comment"];

  // Open the comments.txt file for writing
  $file = fopen("comments.txt", "a");

  // Write the comment to the file
  fwrite($file, "Name: $name\nComment: $comment\n\n");

  // Close the file
  fclose($file);

  // Redirect back to the comments page
  header("Location: comments.html");
?>
